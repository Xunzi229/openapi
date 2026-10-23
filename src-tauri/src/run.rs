use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

static RUNNING: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);
const TIMEOUT: Duration = Duration::from_secs(30);
const OUTPUT_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub millis: u128,
    pub timed_out: bool,
    pub killed: bool,
}

fn remember(run_id: &str, pid: u32) {
    if let Ok(mut guard) = RUNNING.lock() {
        guard.get_or_insert_with(HashMap::new).insert(run_id.to_string(), pid);
    }
}

fn forget(run_id: &str) -> bool {
    RUNNING
        .lock()
        .ok()
        .and_then(|mut guard| guard.as_mut().and_then(|map| map.remove(run_id)))
        .is_some()
}

#[cfg(not(windows))]
fn shell() -> (String, Vec<String>) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    (shell, vec!["-lc".to_string()])
}

/// 把 shell 续行符收成一行，Windows 的 cmd 不认识行尾的 `\`。
fn flatten_command(command: &str) -> String {
    let mut out = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();
    while let Some(ch) = chars.next() {
        if let Some(current) = quote {
            out.push(ch);
            if ch == '\\' && current == '"' {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
                continue;
            }
            if ch == current {
                quote = None;
            }
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            out.push(ch);
            continue;
        }
        if ch == '\\' {
            let mut look = chars.clone();
            while matches!(look.peek(), Some(' ' | '\t')) {
                look.next();
            }
            if matches!(look.peek(), Some('\n' | '\r') | None) {
                while matches!(chars.peek(), Some(' ' | '\t')) {
                    chars.next();
                }
                if chars.peek() == Some(&'\r') {
                    chars.next();
                }
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                while matches!(chars.peek(), Some(' ' | '\t')) {
                    chars.next();
                }
                if !out.ends_with(' ') {
                    out.push(' ');
                }
                continue;
            }
        }
        if ch == '\n' || ch == '\r' {
            if !out.ends_with(' ') {
                out.push(' ');
            }
            continue;
        }
        out.push(ch);
    }
    out.trim().to_string()
}

#[cfg(any(windows, test))]
fn windows_command(command: &str) -> String {
    let trimmed = command.trim_start();
    let lead = &command[..command.len() - trimmed.len()];
    if trimmed == "curl" || trimmed.starts_with("curl ") {
        format!("{lead}curl.exe{}", &trimmed["curl".len()..])
    } else {
        command.to_string()
    }
}

#[cfg(any(windows, test))]
fn powershell_script(command: &str) -> Vec<u8> {
    let body = format!(
        "$ProgressPreference = 'SilentlyContinue'\r\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false\r\n$OutputEncoding = [Console]::OutputEncoding\r\n{command}\r\nexit $LASTEXITCODE\r\n"
    );
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend(body.into_bytes());
    bytes
}

#[cfg_attr(not(windows), allow(unused_variables))]
fn spawn_child(run_id: &str, command: &str) -> Result<(Child, Option<PathBuf>), String> {
    let flat = flatten_command(command);
    #[cfg(windows)]
    {
        let safe: String = run_id
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
            .collect();
        let path = std::env::temp_dir().join(format!("openapi-{safe}.ps1"));
        std::fs::write(&path, powershell_script(&windows_command(&flat))).map_err(|error| format!("写入临时脚本失败: {error}"))?;
        let mut command_line = Command::new("powershell");
        command_line
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        use std::os::windows::process::CommandExt;
        command_line.creation_flags(0x08000000);
        match command_line.spawn() {
            Ok(child) => Ok((child, Some(path))),
            Err(error) => {
                let _ = std::fs::remove_file(&path);
                Err(format!("启动 PowerShell 失败: {error}"))
            }
        }
    }
    #[cfg(not(windows))]
    {
        let (program, args) = shell();
        let mut command_line = Command::new(program);
        command_line
            .args(args)
            .arg(flat)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command_line.process_group(0);
        }
        let child = command_line.spawn().map_err(|error| format!("启动 shell 失败: {error}"))?;
        Ok((child, None))
    }
}

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-9", &format!("-{pid}")]).output();
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
    }
}

fn truncate(mut bytes: Vec<u8>) -> String {
    if bytes.len() > OUTPUT_LIMIT {
        bytes.truncate(OUTPUT_LIMIT);
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        text.push_str("\n…输出超过 2MB，已截断");
        return text;
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

pub fn run(run_id: &str, command: &str) -> Result<RunResult, String> {
    let started = Instant::now();
    let (mut child, script) = spawn_child(run_id, command)?;
    remember(run_id, child.id());

    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(stream) = stdout.as_mut() {
            let _ = stream.read_to_end(&mut buf);
        }
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(stream) = stderr.as_mut() {
            let _ = stream.read_to_end(&mut buf);
        }
        buf
    });

    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if started.elapsed() > TIMEOUT {
                    timed_out = true;
                    kill_pid(child.id());
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(_) => break None,
        }
    };
    let killed = !forget(run_id) && !timed_out;
    if let Some(path) = script {
        let _ = std::fs::remove_file(path);
    }
    let stdout = truncate(out_reader.join().unwrap_or_default());
    let stderr = truncate(err_reader.join().unwrap_or_default());
    Ok(RunResult {
        code: status.and_then(|status| status.code()),
        stdout,
        stderr,
        millis: started.elapsed().as_millis(),
        timed_out,
        killed,
    })
}

pub fn stop(run_id: &str) -> bool {
    let pid = RUNNING
        .lock()
        .ok()
        .and_then(|mut guard| guard.as_mut().and_then(|map| map.remove(run_id)));
    match pid {
        Some(pid) => {
            kill_pid(pid);
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flattens_continued_curl() {
        let source = "curl 'https://a.com/x' \\\n  --header 'X: 1' \\\n  --data 'a b'";
        assert_eq!(flatten_command(source), "curl 'https://a.com/x' --header 'X: 1' --data 'a b'");
    }

    #[test]
    fn keeps_backslash_inside_quotes() {
        assert_eq!(flatten_command("curl --data 'a\\nb'"), "curl --data 'a\\nb'");
    }

    #[test]
    fn windows_uses_curl_exe() {
        assert_eq!(windows_command("curl 'https://a.com'"), "curl.exe 'https://a.com'");
        assert_eq!(windows_command("echo hi"), "echo hi");
        let bytes = powershell_script("curl.exe 'https://a.com'");
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF]);
        let text = String::from_utf8(bytes[3..].to_vec()).unwrap();
        assert!(text.contains("curl.exe 'https://a.com'"));
        assert!(text.contains("exit $LASTEXITCODE"));
    }

    #[cfg(not(windows))]
    #[test]
    fn captures_output_and_code() {
        let result = run("t1", "printf hello; printf err 1>&2; exit 3").unwrap();
        assert_eq!(result.stdout, "hello");
        assert_eq!(result.stderr, "err");
        assert_eq!(result.code, Some(3));
        assert!(!result.timed_out);
    }
}
