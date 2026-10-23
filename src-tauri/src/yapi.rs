use crate::model::{new_id, ApiEntry, Case, Link};
use serde::Serialize;
use serde_json::{Map, Value};
use std::time::Duration;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YapiProject {
    pub name: String,
    pub basepath: String,
    pub envs: Vec<Link>,
    pub apis: Vec<ApiEntry>,
}

pub fn fetch(base: &str, token: &str, host: &str) -> Result<YapiProject, String> {
    let base = base.trim().trim_end_matches('/');
    let token = token.trim();
    if base.is_empty() || token.is_empty() {
        return Err("YApi 地址和 token 不能为空".to_string());
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(30))
        .build();

    let project = get_data(&agent, &format!("{base}/api/project/get?token={token}"))?;
    let pid = project.get("_id").and_then(Value::as_i64).ok_or("YApi 没有返回项目信息")?;
    let name = text(&project, "name");
    let basepath = text(&project, "basepath").trim_end_matches('/').to_string();
    let envs = envs_of(&project);

    let host = host.trim().trim_end_matches('/');
    let host = if host.is_empty() {
        envs.first().map(|env| env.host.trim_end_matches('/').to_string()).unwrap_or_else(|| "http://localhost".to_string())
    } else {
        host.to_string()
    };

    let interfaces = fetch_interfaces(&agent, base, pid, token)?;
    let apis = interfaces
        .iter()
        .filter_map(|(group, item)| interface_to_api(item, &host, &basepath, group))
        .collect();
    Ok(YapiProject { name, basepath, envs, apis })
}

fn fetch_interfaces(agent: &ureq::Agent, base: &str, pid: i64, token: &str) -> Result<Vec<(String, Value)>, String> {
    let full = format!("{base}/api/open/plugin/export-full?type=json&pid={pid}&status=all&token={token}");
    if let Ok(Value::Array(cats)) = get_json(agent, &full) {
        let list = cats
            .iter()
            .flat_map(|cat| {
                let group = text(cat, "name");
                cat.get("list")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(move |item| (group.clone(), item.clone()))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        if !list.is_empty() {
            return Ok(list);
        }
    }
    let menu = get_data(agent, &format!("{base}/api/interface/list_menu?project_id={pid}&token={token}"))?;
    let cats = menu.as_array().cloned().unwrap_or_default();
    let mut list = Vec::new();
    for cat in cats {
        let group = text(&cat, "name");
        let ids: Vec<i64> = cat
            .get("list")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| item.get("_id").and_then(Value::as_i64))
            .collect();
        for id in ids {
            list.push((group.clone(), get_data(agent, &format!("{base}/api/interface/get?id={id}&token={token}"))?));
        }
    }
    Ok(list)
}

fn get_json(agent: &ureq::Agent, url: &str) -> Result<Value, String> {
    let response = agent.get(url).call().map_err(|error| match error {
        ureq::Error::Status(code, _) => format!("HTTP {code}"),
        other => other.to_string(),
    })?;
    response.into_json::<Value>().map_err(|error| error.to_string())
}

fn get_data(agent: &ureq::Agent, url: &str) -> Result<Value, String> {
    let body = get_json(agent, url)?;
    let code = body.get("errcode").and_then(Value::as_i64).unwrap_or(-1);
    if code != 0 {
        let message = body.get("errmsg").and_then(Value::as_str).unwrap_or("YApi 返回了无法识别的内容");
        return Err(format!("YApi：{message}"));
    }
    body.get("data").cloned().ok_or_else(|| "YApi 没有返回 data".to_string())
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

fn envs_of(project: &Value) -> Vec<Link> {
    project
        .get("env")
        .and_then(Value::as_array)
        .map(|envs| {
            envs.iter()
                .filter_map(|env| {
                    let domain = text(env, "domain");
                    if domain.is_empty() {
                        return None;
                    }
                    Some(Link {
                        id: new_id(),
                        label: text(env, "name"),
                        url: String::new(),
                        kind: "env".to_string(),
                        host: domain,
                        note: String::new(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn interface_to_api(item: &Value, host: &str, basepath: &str, group: &str) -> Option<ApiEntry> {
    let method = text(item, "method").to_uppercase();
    let mut path = text(item, "path");
    if method.is_empty() || path.is_empty() {
        return None;
    }
    for param in item.get("req_params").and_then(Value::as_array).into_iter().flatten() {
        let name = text(param, "name");
        let example = text(param, "example");
        if !name.is_empty() && !example.is_empty() {
            path = path.replace(&format!("{{{name}}}"), &example).replace(&format!(":{name}"), &example);
        }
    }
    let full_path = format!("{basepath}{path}");
    let mut lines = Vec::new();
    let title = text(item, "title");
    if !title.is_empty() {
        lines.push(format!("# {title}"));
    }

    let query: Vec<String> = item
        .get("req_query")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|q| {
            let name = text(q, "name");
            (!name.is_empty()).then(|| format!("{name}={}", text(q, "example")))
        })
        .collect();
    let url = if query.is_empty() {
        format!("{host}{full_path}")
    } else {
        format!("{host}{full_path}?{}", query.join("&"))
    };
    let mut first = format!("curl --location '{}'", quote(&url));
    if method != "GET" {
        first = format!("curl --location --request {method} '{}'", quote(&url));
    }
    let mut parts = vec![first];

    let mut has_content_type = false;
    for header in item.get("req_headers").and_then(Value::as_array).into_iter().flatten() {
        let name = text(header, "name");
        if name.is_empty() {
            continue;
        }
        if name.eq_ignore_ascii_case("content-type") {
            has_content_type = true;
        }
        parts.push(format!("--header '{}: {}'", quote(&name), quote(&text(header, "value"))));
    }

    match text(item, "req_body_type").as_str() {
        "json" => {
            let raw = text(item, "req_body_other");
            let body = if item.get("req_body_is_json_schema").and_then(Value::as_bool).unwrap_or(false) {
                serde_json::from_str::<Value>(&raw)
                    .ok()
                    .map(|schema| pretty(&sample(&schema)))
                    .unwrap_or(raw)
            } else {
                serde_json::from_str::<Value>(&raw).ok().map(|v| pretty(&v)).unwrap_or(raw)
            };
            if !has_content_type {
                parts.push("--header 'Content-Type: application/json'".to_string());
            }
            if !body.is_empty() {
                parts.push(format!("--data '{}'", quote(&body)));
            }
        }
        "form" => {
            for field in item.get("req_body_form").and_then(Value::as_array).into_iter().flatten() {
                let name = text(field, "name");
                if !name.is_empty() {
                    parts.push(format!("--form '{}={}'", quote(&name), quote(&text(field, "example"))));
                }
            }
        }
        "raw" => {
            let raw = text(item, "req_body_other");
            if !raw.is_empty() {
                parts.push(format!("--data '{}'", quote(&raw)));
            }
        }
        _ => {}
    }

    lines.push(parts.join(" \\\n  "));
    let mut api = ApiEntry::new(&method, &full_path, vec![Case::new(lines.join("\n"))]);
    api.group = group.trim().to_string();
    Some(api)
}

fn quote(text: &str) -> String {
    text.replace('\'', "'\\''")
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

fn sample(schema: &Value) -> Value {
    if let Some(default) = schema.get("default") {
        return default.clone();
    }
    let kind = match schema.get("type") {
        Some(Value::String(kind)) => kind.as_str(),
        Some(Value::Array(kinds)) => kinds.first().and_then(Value::as_str).unwrap_or(""),
        _ => "",
    };
    match kind {
        "object" => Value::Object(object_sample(schema)),
        "array" => Value::Array(vec![schema.get("items").map(sample).unwrap_or(Value::Null)]),
        "string" => Value::String(String::new()),
        "number" | "integer" => Value::from(0),
        "boolean" => Value::Bool(false),
        _ if schema.get("properties").is_some() => Value::Object(object_sample(schema)),
        _ => Value::Null,
    }
}

fn object_sample(schema: &Value) -> Map<String, Value> {
    schema
        .get("properties")
        .and_then(Value::as_object)
        .map(|props| props.iter().map(|(key, value)| (key.clone(), sample(value))).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_curl_from_json_schema() {
        let item = json!({
            "method": "post",
            "path": "/user/{id}",
            "title": "创建用户",
            "req_params": [{"name": "id", "example": "7"}],
            "req_query": [{"name": "debug", "example": "1"}],
            "req_headers": [{"name": "Authorization", "value": "Bearer x"}],
            "req_body_type": "json",
            "req_body_is_json_schema": true,
            "req_body_other": "{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"},\"tags\":{\"type\":\"array\",\"items\":{\"type\":\"integer\"}}}}"
        });
        let api = interface_to_api(&item, "https://a.com", "/api", "用户").unwrap();
        assert_eq!(api.group, "用户");
        assert_eq!(api.method, "POST");
        assert_eq!(api.path, "/api/user/7");
        let content = &api.cases[0].content;
        assert!(content.starts_with("# 创建用户\ncurl --location --request POST 'https://a.com/api/user/7?debug=1'"));
        assert!(content.contains("--header 'Authorization: Bearer x'"));
        assert!(content.contains("--header 'Content-Type: application/json'"));
        assert!(content.contains("\"name\": \"\""));
        assert!(content.contains("\"tags\": [\n    0\n  ]"));
    }

    #[test]
    fn builds_form_and_get() {
        let get = json!({"method": "GET", "path": "/ping", "req_body_type": "form"});
        let api = interface_to_api(&get, "http://h", "", "").unwrap();
        assert_eq!(api.cases[0].content, "curl --location 'http://h/ping'");

        let form = json!({
            "method": "POST", "path": "/up", "req_body_type": "form",
            "req_body_form": [{"name": "file", "example": "it's"}]
        });
        let api = interface_to_api(&form, "http://h", "", "").unwrap();
        assert!(api.cases[0].content.contains("--form 'file=it'\\''s'"));
    }

    #[test]
    fn reads_envs() {
        let project = json!({"env": [{"name": "local", "domain": "http://127.0.0.1"}, {"name": "empty", "domain": ""}]});
        let envs = envs_of(&project);
        assert_eq!(envs.len(), 1);
        assert_eq!(envs[0].label, "local");
        assert_eq!(envs[0].kind, "env");
    }
}
