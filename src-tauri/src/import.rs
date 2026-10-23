use crate::model::{new_id, ApiEntry, Case, Library, Link, System};
use regex::Regex;
use std::path::Path;

const DOMAIN_ORDER: &[&str] = &[
    "计划",
    "供应链",
    "采购",
    "风控",
    "商品",
    "PMS",
    "实验",
    "算法",
    "集成测试",
    "其他",
];

pub fn parse_dir(root: &Path) -> Result<Library, String> {
    if !root.is_dir() {
        return Err(format!("不是目录: {}", root.display()));
    }
    let mut files = Vec::new();
    collect_markdown(root, &mut files)?;
    files.sort();

    let mut library = Library::default();
    for file in files {
        let text = match std::fs::read_to_string(&file) {
            Ok(text) => text.replace("\r\n", "\n"),
            Err(_) => continue,
        };
        let name = service_name(root, &file);
        let position = library.systems.iter().position(|system| system.name == name);
        if position.is_none() {
            library.systems.push(System {
                id: new_id(),
                name: name.clone(),
                domain: domain_of(&name),
                note: String::new(),
                links: Vec::new(),
                variables: Vec::new(),
                apis: Vec::new(),
            });
        }
        let index = position.unwrap_or(library.systems.len() - 1);
        let system = &mut library.systems[index];
        if system.note.is_empty() {
            if let Some(title) = first_heading(&text) {
                system.note = title;
            }
        }
        let curls = extract_curls(&text);
        let spans: Vec<(usize, usize)> = curls.iter().map(|curl| curl.span).collect();
        for curl in curls {
            push_case(system, &curl.method, &curl.path, curl.raw);
        }
        for command in extract_ab(&text) {
            push_case(system, "POST", &command.path, command.raw);
        }
        for (label, url) in extract_links(&text, &spans) {
            if system.links.iter().any(|link| link.url == url) {
                continue;
            }
            system.links.push(Link::doc(label, url));
        }
    }
    library.systems.retain(|system| !system.apis.is_empty() || !system.links.is_empty());
    sort_library(&mut library);
    Ok(library)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedCurlCommand {
    pub method: String,
    pub path: String,
    pub content: String,
}

pub fn parse_curl_command(text: &str) -> Result<ParsedCurlCommand, String> {
    let text = text.replace("\r\n", "\n");
    let Some(curl) = extract_curls(&text).into_iter().next() else {
        return Err("没有找到 curl 命令".to_string());
    };
    if curl.path == "/未解析" {
        return Err("没有识别出请求地址".to_string());
    }
    Ok(ParsedCurlCommand {
        method: curl.method,
        path: curl.path,
        content: curl.raw,
    })
}

pub fn merge(base: &mut Library, incoming: Library) {
    for system in incoming.systems {
        if let Some(existing) = base.systems.iter_mut().find(|item| item.name == system.name) {
            if existing.note.is_empty() {
                existing.note = system.note;
            }
            if existing.domain.is_empty() {
                existing.domain = system.domain;
            }
            for link in system.links {
                if !existing.links.iter().any(|item| item.url == link.url) {
                    existing.links.push(link);
                }
            }
            for api in system.apis {
                if let Some(found) = existing
                    .apis
                    .iter_mut()
                    .find(|item| item.method == api.method && item.path == api.path)
                {
                    for case in api.cases {
                        if !found.cases.iter().any(|item| item.content == case.content) {
                            found.cases.push(case);
                        }
                    }
                } else {
                    existing.apis.push(api);
                }
            }
        } else {
            base.systems.push(system);
        }
    }
}

fn sort_library(library: &mut Library) {
    library.systems.sort_by(|left, right| {
        domain_rank(&left.domain)
            .cmp(&domain_rank(&right.domain))
            .then(left.name.cmp(&right.name))
    });
    for system in &mut library.systems {
        system
            .apis
            .sort_by(|left, right| left.path.cmp(&right.path).then(left.method.cmp(&right.method)));
    }
}

fn domain_rank(domain: &str) -> usize {
    DOMAIN_ORDER
        .iter()
        .position(|item| *item == domain)
        .unwrap_or(DOMAIN_ORDER.len())
}

fn domain_of(service: &str) -> String {
    if service.contains("集成测试") {
        return "集成测试".to_string();
    }
    if service.starts_with("plan-") {
        return "计划".to_string();
    }
    if service.starts_with("scm-") {
        return "供应链".to_string();
    }
    if service.starts_with("ddmc-") || service == "greatwall" {
        return "采购".to_string();
    }
    if service.starts_with("risk-control") {
        return "风控".to_string();
    }
    if service.starts_with("sku-") {
        return "商品".to_string();
    }
    if service.starts_with("pms-") {
        return "PMS".to_string();
    }
    if service.starts_with("abtest") {
        return "实验".to_string();
    }
    if service.starts_with("algo-") {
        return "算法".to_string();
    }
    "其他".to_string()
}

fn service_name(root: &Path, file: &Path) -> String {
    let relative = file.strip_prefix(root).unwrap_or(file);
    let mut parts: Vec<String> = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    parts.pop();
    if parts.first().is_some_and(|part| part == "services") {
        parts.remove(0);
    }
    if let Some(name) = parts.first() {
        name.clone()
    } else {
        file.file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_else(|| "未命名".to_string())
    }
}

fn collect_markdown(dir: &Path, files: &mut Vec<std::path::PathBuf>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let name = path
            .file_name()
            .map(|item| item.to_string_lossy().into_owned())
            .unwrap_or_default();
        if path.is_dir() {
            if matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist" | "apifox-import") {
                continue;
            }
            collect_markdown(&path, files)?;
            continue;
        }
        if path.extension().is_some_and(|extension| extension == "md")
            && !matches!(name.as_str(), "README.md" | "SERVICE_INDEX.md" | "DATA_INDEX.md")
        {
            files.push(path);
        }
    }
    Ok(())
}

fn first_heading(text: &str) -> Option<String> {
    let heading = Regex::new(r"(?m)^#\s+(.+?)\s*$").ok()?;
    heading
        .captures(text)
        .map(|captures| captures[1].trim().to_string())
        .filter(|title| !title.is_empty())
}

struct FoundCurl {
    span: (usize, usize),
    method: String,
    path: String,
    raw: String,
}

fn extract_curls(text: &str) -> Vec<FoundCurl> {
    let pattern = Regex::new(r"(?m)^[ \t]*(?:<!--[ \t]*)?(?:time[ \t]+)?curl\b").unwrap();
    let mut found = Vec::new();
    for matched in pattern.find_iter(text) {
        let Some(offset) = text[matched.start()..matched.end()].find("curl") else {
            continue;
        };
        let begin = matched.start() + offset;
        let (tokens, end) = tokenize(text, begin);
        if tokens.first().map(String::as_str) != Some("curl") {
            continue;
        }
        let raw = text[begin..end].trim().trim_end_matches("-->").trim().to_string();
        if raw.is_empty() {
            continue;
        }
        let (method, path) = parse_curl(&tokens);
        found.push(FoundCurl {
            span: (begin, end),
            method,
            path,
            raw,
        });
    }
    found
}

struct AbCommand {
    path: String,
    raw: String,
}

fn extract_ab(text: &str) -> Vec<AbCommand> {
    let pattern = Regex::new(r"(?m)^[ \t]*ab\b.*?(https?://\S+)").unwrap();
    let mut commands = Vec::new();
    for captures in pattern.captures_iter(text) {
        let Some(whole) = captures.get(0) else {
            continue;
        };
        let Some(url_match) = captures.get(1) else {
            continue;
        };
        let raw = whole.as_str().trim().to_string();
        let url = url_match.as_str().trim_end_matches(|ch: char| ".,;，。)>]".contains(ch));
        let path = normalize_url(url).map(|url| path_of(&url)).unwrap_or_else(|| "/未解析".to_string());
        commands.push(AbCommand { path, raw });
    }
    commands
}

fn push_case(system: &mut System, method: &str, path: &str, raw: String) {
    if let Some(api) = system
        .apis
        .iter_mut()
        .find(|api| api.method == method && api.path == path)
    {
        if api.cases.iter().any(|case| case.content == raw) {
            return;
        }
        api.cases.push(Case::new(raw));
        return;
    }
    system
        .apis
        .push(ApiEntry::new(method, path, vec![Case::new(raw)]));
}

fn extract_links(text: &str, curl_spans: &[(usize, usize)]) -> Vec<(String, String)> {
    let pattern = Regex::new(r#"https?://[^\s<>()'"]+"#).unwrap();
    let mut links = Vec::new();
    for matched in pattern.find_iter(text) {
        if curl_spans
            .iter()
            .any(|(start, end)| matched.start() >= *start && matched.start() < *end)
        {
            continue;
        }
        let url = matched
            .as_str()
            .trim_end_matches(|ch: char| ".,;，。)>]".contains(ch))
            .to_string();
        if !is_entry_link(&url) || links.iter().any(|(_, existing)| existing == &url) {
            continue;
        }
        links.push((link_label(&url), url));
    }
    links
}

fn is_entry_link(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    if lower.contains(".jpg") || lower.contains(".png") || lower.contains(".jpeg") || lower.contains(".gif") {
        return false;
    }
    lower.contains("paas.")
        || lower.contains("yapi.")
        || lower.contains("corp.100.me")
        || lower.contains("environment?tab")
        || lower.contains("config.corp")
}

fn link_label(url: &str) -> String {
    if let Some(env) = query_param(url, "env") {
        return env;
    }
    let rest = url.split("://").nth(1).unwrap_or(url);
    rest.split('/')
        .next()
        .unwrap_or(rest)
        .split(':')
        .next()
        .unwrap_or(rest)
        .to_string()
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let query = url.split('?').nth(1)?.split('#').next()?;
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=')?;
        if name == key && !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

fn tokenize(text: &str, start: usize) -> (Vec<String>, usize) {
    let mut index = start;
    let length = text.len();
    let mut tokens = Vec::new();
    let mut buffer = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;

    let flush = |started: &mut bool, buffer: &mut String, tokens: &mut Vec<String>| {
        if *started {
            tokens.push(std::mem::take(buffer));
            *started = false;
        }
    };

    while index < length {
        let Some(ch) = text[index..].chars().next() else {
            break;
        };
        let width = ch.len_utf8();
        if quote == Some('\'') {
            if ch == '\'' {
                quote = None;
            } else {
                buffer.push(ch);
            }
            index += width;
            continue;
        }
        if quote == Some('"') {
            if ch == '\\' {
                if let Some(next) = text[index + width..].chars().next() {
                    let next_width = next.len_utf8();
                    if next == '\n' {
                        index += width + next_width;
                        continue;
                    }
                    if matches!(next, '\\' | '"' | '$' | '`') {
                        buffer.push(next);
                        index += width + next_width;
                        continue;
                    }
                    buffer.push(ch);
                    buffer.push(next);
                    index += width + next_width;
                    continue;
                }
            }
            if ch == '"' {
                quote = None;
                index += width;
                continue;
            }
            buffer.push(ch);
            index += width;
            continue;
        }
        if ch == '\\' {
            if let Some(next) = text[index + width..].chars().next() {
                let next_width = next.len_utf8();
                if next == '\n' {
                    index += width + next_width;
                    continue;
                }
                buffer.push(next);
                started = true;
                index += width + next_width;
                continue;
            }
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            started = true;
            index += width;
            continue;
        }
        if ch == ' ' || ch == '\t' || ch == '\r' {
            flush(&mut started, &mut buffer, &mut tokens);
            index += width;
            continue;
        }
        if ch == '\n' || ch == '|' || (ch == '#' && !started) || (ch == '`' && !started) {
            flush(&mut started, &mut buffer, &mut tokens);
            return (tokens, index);
        }
        buffer.push(ch);
        started = true;
        index += width;
    }
    flush(&mut started, &mut buffer, &mut tokens);
    (tokens, index)
}

fn parse_curl(tokens: &[String]) -> (String, String) {
    let mut method: Option<String> = None;
    let mut url: Option<String> = None;
    let mut has_body = false;
    let mut force_get = false;
    let mut is_head = false;
    let mut index = 1;
    while index < tokens.len() {
        let token = tokens[index].as_str();
        if token == "-->" {
            index += 1;
            continue;
        }
        if let Some(value) = token.strip_prefix("--request=") {
            method = Some(value.to_string());
            index += 1;
            continue;
        }
        if let Some(value) = token.strip_prefix("--url=") {
            url = Some(value.to_string());
            index += 1;
            continue;
        }
        if token.starts_with("--data=")
            || token.starts_with("--data-raw=")
            || token.starts_with("--data-binary=")
            || token.starts_with("--data-ascii=")
            || token.starts_with("--data-urlencode=")
            || token.starts_with("--form=")
            || token.starts_with("--form-string=")
        {
            has_body = true;
            index += 1;
            continue;
        }
        if let Some(value) = token.strip_prefix("-X") {
            if !value.is_empty() && !token.starts_with("--") {
                method = Some(value.to_string());
                index += 1;
                continue;
            }
        }
        if token.starts_with("-d") && token != "-d" && !token.starts_with("--") {
            has_body = true;
            index += 1;
            continue;
        }
        if token.starts_with("-H") && token != "-H" && !token.starts_with("--") {
            index += 1;
            continue;
        }
        if takes_value(token) {
            if matches!(
                token,
                "-d" | "--data"
                    | "--data-raw"
                    | "--data-binary"
                    | "--data-ascii"
                    | "--data-urlencode"
                    | "-F"
                    | "--form"
                    | "--form-string"
            ) {
                has_body = true;
            }
            if token == "-X" || token == "--request" {
                if let Some(value) = tokens.get(index + 1) {
                    method = Some(value.clone());
                }
            }
            if token == "--url" {
                if let Some(value) = tokens.get(index + 1) {
                    url = Some(value.clone());
                }
            }
            index += 2;
            continue;
        }
        if matches!(
            token,
            "--location"
                | "--compressed"
                | "--insecure"
                | "--silent"
                | "--show-error"
                | "--verbose"
                | "--fail"
                | "--get"
                | "--head"
                | "--http1.1"
                | "--http2"
                | "--path-as-is"
                | "--globoff"
        ) {
            if token == "--get" {
                force_get = true;
            }
            if token == "--head" {
                is_head = true;
            }
            index += 1;
            continue;
        }
        if is_bool_cluster(token) {
            if token.contains('G') {
                force_get = true;
            }
            if token.contains('I') {
                is_head = true;
            }
            index += 1;
            continue;
        }
        if token.starts_with('-') {
            index += 1;
            continue;
        }
        if url.is_none() {
            url = Some(token.to_string());
        }
        index += 1;
    }

    let Some(raw_url) = url.as_deref().and_then(normalize_url) else {
        return ("CURL".to_string(), "/未解析".to_string());
    };
    let method = if is_head {
        "HEAD".to_string()
    } else if force_get {
        "GET".to_string()
    } else if let Some(method) = method {
        method.to_ascii_uppercase()
    } else if has_body {
        "POST".to_string()
    } else {
        "GET".to_string()
    };
    (method, path_of(&raw_url))
}

fn takes_value(token: &str) -> bool {
    matches!(
        token,
        "-X" | "--request"
            | "-H"
            | "--header"
            | "-d"
            | "--data"
            | "--data-raw"
            | "--data-binary"
            | "--data-ascii"
            | "--data-urlencode"
            | "-b"
            | "--cookie"
            | "-A"
            | "--user-agent"
            | "-u"
            | "--user"
            | "-e"
            | "--referer"
            | "--url"
            | "-o"
            | "--output"
            | "-m"
            | "--max-time"
            | "--connect-timeout"
            | "--retry"
            | "--proxy"
            | "-x"
            | "-w"
            | "--write-out"
            | "-F"
            | "--form"
            | "--form-string"
            | "--resolve"
            | "-T"
            | "--upload-file"
            | "-c"
            | "--cookie-jar"
    )
}

fn is_bool_cluster(token: &str) -> bool {
    let Some(body) = token.strip_prefix('-') else {
        return false;
    };
    !body.is_empty()
        && !body.starts_with('-')
        && body.chars().all(|ch| matches!(ch, 's' | 'S' | 'k' | 'L' | 'v' | 'f' | 'G' | 'I' | 'g' | 'N'))
}

fn normalize_url(raw: &str) -> Option<String> {
    let url = raw.trim().trim_matches(|ch| ch == '"' || ch == '\'');
    if url.starts_with("http://") || url.starts_with("https://") {
        return Some(url.to_string());
    }
    if url.contains('/') && (url.contains('.') || url.contains(':')) {
        return Some(format!("http://{url}"));
    }
    None
}

fn path_of(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let path = match rest.find('/') {
        Some(index) => &rest[index..],
        None => "/",
    };
    let path = path.split(['?', '#']).next().unwrap_or("/");
    if path.is_empty() {
        "/".to_string()
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_same_path_and_keeps_two_curls() {
        let dir = std::env::temp_dir().join(format!("openapi-import-{}", std::process::id()));
        let services = dir.join("services").join("plan-rule-engine-svc-service");
        std::fs::create_dir_all(&services).unwrap();
        std::fs::write(
            dir.join("services").join("scm-po-service.md"),
            r#"
# 采购订单与预约取号接口

https://paas.ddmc-inc.com/app/scm-po-service/environment?tab=info&env=TE

### 1. 接口请求

```bash
curl 'http://10.23.251.37:8080/api/purchase-order/po-detail' \
  --header 'Content-Type: application/json' \
  --data '{"purchase_id":91275125}'
```

### 2. 接口请求

```bash
curl 'http://scm-po-service.example.com:8080/api/purchase-order/po-detail' \
  --data '{"purchase_id":8696770}'
```
"#,
        )
        .unwrap();
        std::fs::write(
            services.join("feature.md"),
            "curl --location '10.82.8.6:8080/ppms/api/v1/allocate/parameter/query/realtime_pick' \\\n--data '{\"a\":1}'\n",
        )
        .unwrap();
        std::fs::write(dir.join("README.md"), "curl 'http://example.com/ignored'\n").unwrap();

        let library = parse_dir(&dir).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();

        assert_eq!(library.systems.len(), 2);
        let scm = library
            .systems
            .iter()
            .find(|system| system.name == "scm-po-service")
            .unwrap();
        assert_eq!(scm.domain, "供应链");
        assert_eq!(scm.note, "采购订单与预约取号接口");
        assert_eq!(scm.links.len(), 1);
        assert_eq!(scm.links[0].label, "TE");
        assert_eq!(scm.apis.len(), 1);
        assert_eq!(scm.apis[0].method, "POST");
        assert_eq!(scm.apis[0].path, "/api/purchase-order/po-detail");
        assert_eq!(scm.apis[0].cases.len(), 2);
        assert!(scm.apis[0].cases[0].content.contains("91275125"));
        assert!(!scm.apis[0].cases[0].content.contains("```"));

        let plan = library
            .systems
            .iter()
            .find(|system| system.name == "plan-rule-engine-svc-service")
            .unwrap();
        assert_eq!(plan.domain, "计划");
        assert_eq!(
            plan.apis[0].path,
            "/ppms/api/v1/allocate/parameter/query/realtime_pick"
        );
    }

    #[test]
    fn parses_pasted_curl_into_method_and_path() {
        let parsed = parse_curl_command(
            "curl 'http://10.78.78.18:8080/api/abnormalReporting/create' \\\n  --header 'Content-Type: application/json' \\\n  --data '{\"title\":\"算法出单异常\"}'\n",
        )
        .unwrap();
        assert_eq!(parsed.method, "POST");
        assert_eq!(parsed.path, "/api/abnormalReporting/create");
        assert!(parsed.content.contains("算法出单异常"));
        assert!(parse_curl_command("不是命令").is_err());
    }

    #[test]
    fn stops_piped_curl_and_keeps_get() {
        let (tokens, _) = tokenize(
            "curl \"http://example.com/api/activities\" | python -m json.tool\n",
            0,
        );
        let (method, path) = parse_curl(&tokens);
        assert_eq!(method, "GET");
        assert_eq!(path, "/api/activities");
        assert!(!tokens.iter().any(|token| token == "python"));
    }

    #[test]
    fn empty_data_is_still_post() {
        let text = "curl --location 'http://example.com/ppms/api/v1/allocate/parameter/query/all_warehouse_fdc/transfer_unit' \\\n--data ''\n";
        let curls = extract_curls(text);
        assert_eq!(curls.len(), 1);
        assert_eq!(curls[0].method, "POST");
        assert!(curls[0].path.ends_with("/transfer_unit"));
    }

    #[test]
    fn imports_directory_from_env() {
        let Ok(dir) = std::env::var("OPENAPI_IMPORT_DIR") else {
            return;
        };
        let library = parse_dir(std::path::Path::new(&dir)).unwrap();
        let apis: usize = library.systems.iter().map(|system| system.apis.len()).sum();
        let cases: usize = library
            .systems
            .iter()
            .map(|system| system.apis.iter().map(|api| api.cases.len()).sum::<usize>())
            .sum();
        let links: usize = library.systems.iter().map(|system| system.links.len()).sum();
        eprintln!(
            "systems {} apis {} cases {} links {}",
            library.systems.len(),
            apis,
            cases,
            links
        );
        if let Ok(out) = std::env::var("OPENAPI_LIBRARY_OUT") {
            let path = std::path::PathBuf::from(&out);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            let text = serde_json::to_string_pretty(&library).unwrap();
            std::fs::write(&path, text).unwrap();
            eprintln!("wrote {}", path.display());
        }
        assert!(cases > 300, "cases {cases}");
        assert!(links > 0);
    }

    #[test]
    fn merge_skips_identical_case() {
        let dir = std::env::temp_dir().join(format!("openapi-merge-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("abtest-service.md"), "curl 'http://example.com/api/activities'\n").unwrap();
        let incoming = parse_dir(&dir).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        let mut base = incoming.clone();
        merge(&mut base, incoming);
        assert_eq!(base.systems.len(), 1);
        assert_eq!(base.systems[0].domain, "实验");
        assert_eq!(base.systems[0].apis[0].cases.len(), 1);
    }
}
