use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub fn new_id() -> String {
    let seq = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("{millis:x}{seq:x}")
}

pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    #[serde(default)]
    pub systems: Vec<System>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct System {
    pub id: String,
    pub name: String,
    pub domain: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub groups: Vec<String>,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub links: Vec<Link>,
    #[serde(default)]
    pub variables: Vec<Variable>,
    #[serde(default)]
    pub apis: Vec<ApiEntry>,
}

fn default_kind() -> String {
    "doc".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub url: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub note: String,
}

impl Link {
    pub fn doc(label: String, url: String) -> Self {
        let kind = if is_env_url(&url) { "env" } else { "doc" };
        Self {
            id: new_id(),
            label,
            url,
            kind: kind.to_string(),
            host: String::new(),
            note: String::new(),
        }
    }
}

pub fn is_env_url(url: &str) -> bool {
    url.contains("environment?tab") || url.contains("env=")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Variable {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub secret: bool,
    /// 空字符串是全局变量，否则是某个环境的 id。
    #[serde(default)]
    pub env_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiEntry {
    pub id: String,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub note: String,
    /// 空字符串表示未分组。
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub starred: bool,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub cases: Vec<Case>,
}

impl ApiEntry {
    pub fn new(method: &str, path: &str, cases: Vec<Case>) -> Self {
        Self {
            id: new_id(),
            method: method.to_string(),
            path: path.to_string(),
            note: String::new(),
            group: String::new(),
            starred: false,
            updated_at: now_millis(),
            cases,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Case {
    pub id: String,
    pub content: String,
    #[serde(default)]
    pub updated_at: i64,
}

impl Case {
    pub fn new(content: String) -> Self {
        Self {
            id: new_id(),
            content,
            updated_at: now_millis(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewLog {
    pub category: String,
    pub action: String,
    #[serde(default)]
    pub system_id: String,
    #[serde(default)]
    pub system_name: String,
    #[serde(default)]
    pub api_id: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub result: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: i64,
    pub at: i64,
    pub category: String,
    pub action: String,
    pub system_id: String,
    pub system_name: String,
    pub api_id: String,
    pub target: String,
    pub detail: String,
    pub result: String,
}
