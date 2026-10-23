use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
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

fn shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        ("cmd".to_string(), vec!["/C".to_string()])
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        (shell, vec!["-lc".to_string()])
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
    let (program, args) = shell();
    let started = Instant::now();
    let mut child = Command::new(program)
        .args(args)
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动 shell 失败: {error}"))?;
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
    fn captures_output_and_code() {
        let result = run("t1", "printf hello; printf err 1>&2; exit 3").unwrap();
        assert_eq!(result.stdout, "hello");
        assert_eq!(result.stderr, "err");
        assert_eq!(result.code, Some(3));
        assert!(!result.timed_out);
    }
}
