use crate::import;
use crate::model::{now_millis, ApiEntry, Case, Library, Link, LogEntry, NewLog, System, Variable};
use rusqlite::types::Value;
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

static GUARD: Mutex<()> = Mutex::new(());
const BACKUP_KEEP: usize = 7;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS systems (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    domain TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    groups TEXT NOT NULL DEFAULT '[]',
    color TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    system_id TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'doc',
    host TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS variables (
    id TEXT PRIMARY KEY,
    system_id TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    secret INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS apis (
    id TEXT PRIMARY KEY,
    system_id TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    api_group TEXT NOT NULL DEFAULT '',
    starred INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    api_id TEXT NOT NULL REFERENCES apis(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    category TEXT NOT NULL,
    action TEXT NOT NULL,
    system_id TEXT NOT NULL DEFAULT '',
    system_name TEXT NOT NULL DEFAULT '',
    api_id TEXT NOT NULL DEFAULT '',
    target TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_logs_at ON logs(at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_system ON logs(system_id);
CREATE INDEX IF NOT EXISTS idx_logs_api ON logs(api_id);
CREATE INDEX IF NOT EXISTS idx_links_system ON links(system_id, position);
CREATE INDEX IF NOT EXISTS idx_variables_system ON variables(system_id, position);
CREATE INDEX IF NOT EXISTS idx_apis_system ON apis(system_id, position);
CREATE INDEX IF NOT EXISTS idx_cases_api ON cases(api_id, position);
";

const COLUMNS: &[(&str, &str, &str)] = &[
    ("systems", "groups", "TEXT NOT NULL DEFAULT '[]'"),
    ("systems", "color", "TEXT NOT NULL DEFAULT ''"),
    ("links", "kind", "TEXT NOT NULL DEFAULT 'doc'"),
    ("links", "host", "TEXT NOT NULL DEFAULT ''"),
    ("links", "note", "TEXT NOT NULL DEFAULT ''"),
    ("apis", "note", "TEXT NOT NULL DEFAULT ''"),
    ("apis", "api_group", "TEXT NOT NULL DEFAULT ''"),
    ("apis", "starred", "INTEGER NOT NULL DEFAULT 0"),
    ("apis", "updated_at", "INTEGER NOT NULL DEFAULT 0"),
    ("cases", "updated_at", "INTEGER NOT NULL DEFAULT 0"),
    ("variables", "env_id", "TEXT NOT NULL DEFAULT ''"),
];

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(names.iter().any(|name| name == column))
}

fn upgrade(conn: &Connection) -> Result<(), String> {
    for (table, column, ddl) in COLUMNS {
        if has_column(conn, table, column)? {
            continue;
        }
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
            .map_err(|error| error.to_string())?;
        if *table == "links" && *column == "kind" {
            conn.execute_batch(
                "UPDATE links SET kind = 'env' WHERE url LIKE '%environment?tab%' OR url LIKE '%env=%'",
            )
            .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn connect(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let conn = Connection::open(path).map_err(|error| error.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| error.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| error.to_string())?;
    conn.execute_batch(SCHEMA).map_err(|error| error.to_string())?;
    upgrade(&conn)?;
    Ok(conn)
}

fn read_library(conn: &Connection) -> Result<Library, String> {
    let mut systems = query_systems(conn)?;
    for system in &mut systems {
        system.links = query_links(conn, &system.id)?;
        system.variables = query_variables(conn, &system.id)?;
        system.apis = query_apis(conn, &system.id)?;
    }
    Ok(Library { systems })
}

fn read_groups(text: &str) -> Vec<String> {
    serde_json::from_str(text).unwrap_or_default()
}

fn query_systems(conn: &Connection) -> Result<Vec<System>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, domain, note, groups, color FROM systems ORDER BY position")
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let groups: String = row.get(4)?;
            Ok(System {
                id: row.get(0)?,
                name: row.get(1)?,
                domain: row.get(2)?,
                note: row.get(3)?,
                groups: read_groups(&groups),
                color: row.get(5)?,
                links: Vec::new(),
                variables: Vec::new(),
                apis: Vec::new(),
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn query_links(conn: &Connection, system_id: &str) -> Result<Vec<Link>, String> {
    let mut stmt = conn
        .prepare("SELECT id, label, url, kind, host, note FROM links WHERE system_id = ?1 ORDER BY position")
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([system_id], |row| {
            Ok(Link {
                id: row.get(0)?,
                label: row.get(1)?,
                url: row.get(2)?,
                kind: row.get(3)?,
                host: row.get(4)?,
                note: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn query_variables(conn: &Connection, system_id: &str) -> Result<Vec<Variable>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, value, secret, env_id FROM variables WHERE system_id = ?1 ORDER BY position")
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([system_id], |row| {
            Ok(Variable {
                id: row.get(0)?,
                name: row.get(1)?,
                value: row.get(2)?,
                secret: row.get::<_, i64>(3)? != 0,
                env_id: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn query_apis(conn: &Connection, system_id: &str) -> Result<Vec<ApiEntry>, String> {
    let mut stmt = conn
        .prepare("SELECT id, method, path, note, api_group, starred, updated_at FROM apis WHERE system_id = ?1 ORDER BY position")
        .map_err(|error| error.to_string())?;
    let mut apis = stmt
        .query_map([system_id], |row| {
            Ok(ApiEntry {
                id: row.get(0)?,
                method: row.get(1)?,
                path: row.get(2)?,
                note: row.get(3)?,
                group: row.get(4)?,
                starred: row.get::<_, i64>(5)? != 0,
                updated_at: row.get(6)?,
                cases: Vec::new(),
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(stmt);
    for api in &mut apis {
        api.cases = query_cases(conn, &api.id)?;
    }
    Ok(apis)
}

fn query_cases(conn: &Connection, api_id: &str) -> Result<Vec<Case>, String> {
    let mut stmt = conn
        .prepare("SELECT id, content, updated_at FROM cases WHERE api_id = ?1 ORDER BY position")
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([api_id], |row| {
            Ok(Case {
                id: row.get(0)?,
                content: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn write_library(conn: &Connection, library: &Library) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|error| error.to_string())?;
    tx.execute_batch(
        "DELETE FROM cases; DELETE FROM apis; DELETE FROM variables; DELETE FROM links; DELETE FROM systems;",
    )
    .map_err(|error| error.to_string())?;
    for (system_index, system) in library.systems.iter().enumerate() {
        tx.execute(
            "INSERT INTO systems (id, name, domain, note, groups, color, position) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                system.id,
                system.name,
                system.domain,
                system.note,
                serde_json::to_string(&system.groups).unwrap_or_else(|_| "[]".to_string()),
                system.color,
                system_index as i64
            ],
        )
        .map_err(|error| error.to_string())?;
        for (link_index, link) in system.links.iter().enumerate() {
            tx.execute(
                "INSERT INTO links (id, system_id, label, url, kind, host, note, position) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    link.id,
                    system.id,
                    link.label,
                    link.url,
                    link.kind,
                    link.host,
                    link.note,
                    link_index as i64
                ],
            )
            .map_err(|error| error.to_string())?;
        }
        for (variable_index, variable) in system.variables.iter().enumerate() {
            tx.execute(
                "INSERT INTO variables (id, system_id, name, value, secret, env_id, position) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    variable.id,
                    system.id,
                    variable.name,
                    variable.value,
                    variable.secret as i64,
                    variable.env_id,
                    variable_index as i64
                ],
            )
            .map_err(|error| error.to_string())?;
        }
        for (api_index, api) in system.apis.iter().enumerate() {
            tx.execute(
                "INSERT INTO apis (id, system_id, method, path, note, api_group, starred, updated_at, position) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    api.id,
                    system.id,
                    api.method,
                    api.path,
                    api.note,
                    api.group,
                    api.starred as i64,
                    api.updated_at,
                    api_index as i64
                ],
            )
            .map_err(|error| error.to_string())?;
            for (case_index, case) in api.cases.iter().enumerate() {
                tx.execute(
                    "INSERT INTO cases (id, api_id, content, updated_at, position) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![case.id, api.id, case.content, case.updated_at, case_index as i64],
                )
                .map_err(|error| error.to_string())?;
            }
        }
    }
    tx.commit().map_err(|error| error.to_string())
}

fn system_count(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM systems", [], |row| row.get(0))
        .map_err(|error| error.to_string())
}

fn migrate_json(conn: &Connection, json_path: &Path) -> Result<(), String> {
    if system_count(conn)? > 0 || !json_path.exists() {
        return Ok(());
    }
    let text = std::fs::read_to_string(json_path).map_err(|error| error.to_string())?;
    let library: Library = serde_json::from_str(&text).map_err(|error| format!("读取 library.json 失败: {error}"))?;
    write_library(conn, &library)?;
    let backup = json_path.with_file_name("library.json.imported");
    std::fs::rename(json_path, backup).map_err(|error| error.to_string())
}

fn backup_dir(data: &Path) -> PathBuf {
    data.join("backups")
}

fn write_backup(data: &Path, library: &Library) -> Result<PathBuf, String> {
    if library.systems.is_empty() {
        return Err("没有数据，不备份".to_string());
    }
    let dir = backup_dir(data);
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let stamp = crate::model::now_millis();
    let path = dir.join(format!("library-{stamp}.json"));
    let text = serde_json::to_string(library).map_err(|error| error.to_string())?;
    std::fs::write(&path, text).map_err(|error| error.to_string())?;
    prune_backups(&dir)?;
    Ok(path)
}

fn prune_backups(dir: &Path) -> Result<(), String> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("library-") && name.ends_with(".json"))
        })
        .collect();
    files.sort();
    while files.len() > BACKUP_KEEP {
        let oldest = files.remove(0);
        let _ = std::fs::remove_file(oldest);
    }
    Ok(())
}

pub fn load(app: &AppHandle) -> Result<Library, String> {
    let _guard = GUARD.lock().map_err(|error| error.to_string())?;
    let dir = data_dir(app)?;
    let conn = connect(&dir.join("library.db"))?;
    migrate_json(&conn, &dir.join("library.json"))?;
    let library = read_library(&conn)?;
    let _ = write_backup(&dir, &library);
    Ok(library)
}

pub fn save(app: &AppHandle, library: &Library) -> Result<(), String> {
    let _guard = GUARD.lock().map_err(|error| error.to_string())?;
    let dir = data_dir(app)?;
    let conn = connect(&dir.join("library.db"))?;
    write_library(&conn, library)
}

pub fn import_dir(app: &AppHandle, dir: &Path) -> Result<Library, String> {
    let _guard = GUARD.lock().map_err(|error| error.to_string())?;
    let data = data_dir(app)?;
    let conn = connect(&data.join("library.db"))?;
    migrate_json(&conn, &data.join("library.json"))?;
    let mut current = read_library(&conn)?;
    let incoming = import::parse_dir(dir)?;
    import::merge(&mut current, incoming);
    write_library(&conn, &current)?;
    Ok(current)
}

pub fn backup_to(app: &AppHandle, target: &Path) -> Result<(), String> {
    let _guard = GUARD.lock().map_err(|error| error.to_string())?;
    let dir = data_dir(app)?;
    let conn = connect(&dir.join("library.db"))?;
    let library = read_library(&conn)?;
    let text = serde_json::to_string_pretty(&library).map_err(|error| error.to_string())?;
    std::fs::write(target, text).map_err(|error| error.to_string())
}

const LOG_RESULT_LIMIT: usize = 20_000;
const LOG_KEEP: i64 = 5000;

fn clip_text(text: &str) -> String {
    if text.len() <= LOG_RESULT_LIMIT {
        return text.to_string();
    }
    let mut end = LOG_RESULT_LIMIT;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…已截断", &text[..end])
}

fn like_pattern(keyword: &str) -> String {
    let escaped = keyword.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    format!("%{escaped}%")
}

pub fn append_log(conn: &Connection, entry: &NewLog) -> Result<(), String> {
    conn.execute(
        "INSERT INTO logs (at, category, action, system_id, system_name, api_id, target, detail, result)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            now_millis(),
            entry.category.trim(),
            entry.action.trim(),
            entry.system_id,
            entry.system_name,
            entry.api_id,
            entry.target,
            clip_text(&entry.detail),
            clip_text(&entry.result),
        ],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?1)",
        params![LOG_KEEP],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn log_clause(category: &str, keyword: &str, system_id: &str, from_at: i64, to_at: i64) -> (String, Vec<Value>) {
    let category = category.trim();
    let keyword = keyword.trim();
    let system_id = system_id.trim();
    let mut sql = String::from(" WHERE 1 = 1");
    let mut values: Vec<Value> = Vec::new();
    if !system_id.is_empty() {
        sql.push_str(" AND system_id = ?");
        values.push(Value::Text(system_id.to_string()));
    }
    if !category.is_empty() {
        sql.push_str(" AND category = ?");
        values.push(Value::Text(category.to_string()));
    }
    if from_at > 0 {
        sql.push_str(" AND at >= ?");
        values.push(Value::Integer(from_at));
    }
    if to_at > 0 {
        sql.push_str(" AND at <= ?");
        values.push(Value::Integer(to_at));
    }
    if !keyword.is_empty() {
        sql.push_str(
            " AND (action LIKE ? ESCAPE '\\' OR system_name LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\' OR result LIKE ? ESCAPE '\\')",
        );
        let pattern = like_pattern(keyword);
        for _ in 0..5 {
            values.push(Value::Text(pattern.clone()));
        }
    }
    (sql, values)
}

pub fn query_logs(
    conn: &Connection,
    category: &str,
    keyword: &str,
    system_id: &str,
    from_at: i64,
    to_at: i64,
) -> Result<Vec<LogEntry>, String> {
    let (clause, values) = log_clause(category, keyword, system_id, from_at, to_at);
    let sql = format!(
        "SELECT id, at, category, action, system_id, system_name, api_id, target, detail, result FROM logs{clause} ORDER BY id DESC LIMIT 200"
    );
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(values.iter()), |row| {
            Ok(LogEntry {
                id: row.get(0)?,
                at: row.get(1)?,
                category: row.get(2)?,
                action: row.get(3)?,
                system_id: row.get(4)?,
                system_name: row.get(5)?,
                api_id: row.get(6)?,
                target: row.get(7)?,
                detail: row.get(8)?,
                result: row.get(9)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

pub fn clear_logs(
    conn: &Connection,
    category: &str,
    keyword: &str,
    system_id: &str,
    from_at: i64,
    to_at: i64,
) -> Result<usize, String> {
    let (clause, values) = log_clause(category, keyword, system_id, from_at, to_at);
    conn.execute(&format!("DELETE FROM logs{clause}"), rusqlite::params_from_iter(values.iter()))
        .map_err(|error| error.to_string())
}

pub fn delete_related_logs(conn: &Connection, system_id: &str, api_id: &str) -> Result<(), String> {
    let api_id = api_id.trim();
    let system_id = system_id.trim();
    if !api_id.is_empty() {
        conn.execute("DELETE FROM logs WHERE api_id = ?1", [api_id]).map_err(|error| error.to_string())?;
    } else if !system_id.is_empty() {
        conn.execute("DELETE FROM logs WHERE system_id = ?1", [system_id]).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn add_log(app: &AppHandle, entry: &NewLog) -> Result<(), String> {
    let _guard = GUARD.lock().map_err(|error| error.to_string())?;
    let dir = data_dir(app)?;
    let conn = connect(&dir.join("library.db"))?;
    append_log(&conn, entry)
}

pub fn list_logs(
    app: &AppHandle,
    category: &str,
    keyword: &str,
    system_id: &str,
    from_at: i64,
    to_at: i64,
) -> Result<Vec<LogEntry>, String> {
    let _guard = GUARD.lock().map_err(|error| error.to_string())?;
    let dir = data_dir(app)?;
    let conn = connect(&dir.join("library.db"))?;
    query_logs(&conn, category, keyword, system_id, from_at, to_at)
}

pub fn purge_logs(
    app: &AppHandle,
    category: &str,
    keyword: &str,
    system_id: &str,
    from_at: i64,
    to_at: i64,
) -> Result<usize, String> {
    let _guard = GUARD.lock().map_err(|error| error.to_string())?;
    let dir = data_dir(app)?;
    let conn = connect(&dir.join("library.db"))?;
    clear_logs(&conn, category, keyword, system_id, from_at, to_at)
}

pub fn remove_related_logs(app: &AppHandle, system_id: &str, api_id: &str) -> Result<(), String> {
    let _guard = GUARD.lock().map_err(|error| error.to_string())?;
    let dir = data_dir(app)?;
    let conn = connect(&dir.join("library.db"))?;
    delete_related_logs(&conn, system_id, api_id)
}

pub fn restore_from(app: &AppHandle, source: &Path) -> Result<Library, String> {
    let _guard = GUARD.lock().map_err(|error| error.to_string())?;
    let text = std::fs::read_to_string(source).map_err(|error| error.to_string())?;
    let library: Library = serde_json::from_str(&text).map_err(|error| format!("备份文件无法读取: {error}"))?;
    let dir = data_dir(app)?;
    let conn = connect(&dir.join("library.db"))?;
    let current = read_library(&conn)?;
    let _ = write_backup(&dir, &current);
    write_library(&conn, &library)?;
    Ok(library)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::NewLog;

    fn sample() -> Library {
        Library {
            systems: vec![System {
                id: "s1".to_string(),
                name: "scm-po-service".to_string(),
                domain: "供应链".to_string(),
                note: "采购订单".to_string(),
                groups: vec!["用户".to_string()],
                color: String::new(),
                links: vec![Link {
                    id: "l1".to_string(),
                    label: "TE".to_string(),
                    url: "https://paas.example.com/env=TE".to_string(),
                    kind: "env".to_string(),
                    host: "https://scm-po.te.example.com".to_string(),
                    note: String::new(),
                }],
                variables: vec![Variable {
                    id: "v1".to_string(),
                    name: "token".to_string(),
                    value: "abc".to_string(),
                    secret: true,
                    env_id: String::new(),
                }],
                apis: vec![ApiEntry {
                    id: "a1".to_string(),
                    method: "POST".to_string(),
                    path: "/api/purchase-order/po-detail".to_string(),
                    note: "幂等".to_string(),
                    group: String::new(),
                    starred: true,
                    updated_at: 5,
                    cases: vec![
                        Case {
                            id: "c1".to_string(),
                            content: "curl 'http://example.com/a'".to_string(),
                            updated_at: 1,
                        },
                        Case {
                            id: "c2".to_string(),
                            content: "curl 'http://example.com/b'".to_string(),
                            updated_at: 2,
                        },
                    ],
                }],
            }],
        }
    }

    #[test]
    fn roundtrip_keeps_order_and_text() {
        let dir = std::env::temp_dir().join(format!("openapi-sqlite-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = connect(&dir.join("library.db")).unwrap();
        let original = sample();
        write_library(&conn, &original).unwrap();
        let loaded = read_library(&conn).unwrap();
        assert_eq!(
            serde_json::to_value(&loaded).unwrap(),
            serde_json::to_value(&original).unwrap()
        );
        drop(conn);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn upgrades_old_schema() {
        let dir = std::env::temp_dir().join(format!("openapi-sqlite-upgrade-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("library.db");
        {
            let old = Connection::open(&path).unwrap();
            old.execute_batch(
                "CREATE TABLE systems (id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL);
                 CREATE TABLE links (id TEXT PRIMARY KEY, system_id TEXT NOT NULL, label TEXT NOT NULL, url TEXT NOT NULL, position INTEGER NOT NULL);
                 CREATE TABLE apis (id TEXT PRIMARY KEY, system_id TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, position INTEGER NOT NULL);
                 CREATE TABLE cases (id TEXT PRIMARY KEY, api_id TEXT NOT NULL, content TEXT NOT NULL, position INTEGER NOT NULL);
                 INSERT INTO systems VALUES ('s1', 'svc', '其他', '', 0);
                 INSERT INTO links VALUES ('l1', 's1', 'TEHW', 'https://paas.example.com/app/svc/environment?tab=info&env=TEHW', 0);
                 INSERT INTO links VALUES ('l2', 's1', 'yapi', 'https://yapi.example.com/p/1', 1);",
            )
            .unwrap();
        }
        let conn = connect(&path).unwrap();
        let library = read_library(&conn).unwrap();
        let links = &library.systems[0].links;
        assert_eq!(links[0].kind, "env");
        assert_eq!(links[1].kind, "doc");
        assert!(library.systems[0].groups.is_empty());
        assert!(library.systems[0].color.is_empty());
        drop(conn);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn migrates_json_once() {
        let dir = std::env::temp_dir().join(format!("openapi-sqlite-migrate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let json_path = dir.join("library.json");
        std::fs::write(&json_path, serde_json::to_string(&sample()).unwrap()).unwrap();
        let conn = connect(&dir.join("library.db")).unwrap();
        migrate_json(&conn, &json_path).unwrap();
        assert!(!json_path.exists());
        assert!(dir.join("library.json.imported").exists());
        assert_eq!(read_library(&conn).unwrap().systems.len(), 1);
        migrate_json(&conn, &dir.join("library.json.imported")).unwrap();
        assert_eq!(system_count(&conn).unwrap(), 1);
        drop(conn);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn keeps_seven_backups() {
        let dir = std::env::temp_dir().join(format!("openapi-backups-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for index in 0..10 {
            let path = backup_dir(&dir).join(format!("library-{index:03}.json"));
            std::fs::create_dir_all(backup_dir(&dir)).unwrap();
            std::fs::write(path, "{}").unwrap();
        }
        write_backup(&dir, &sample()).unwrap();
        let count = std::fs::read_dir(backup_dir(&dir)).unwrap().count();
        assert_eq!(count, BACKUP_KEEP);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn logs_survive_library_rewrite() {
        let dir = std::env::temp_dir().join(format!("openapi-logs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = connect(&dir.join("library.db")).unwrap();
        append_log(
            &conn,
            &NewLog {
                category: "run".to_string(),
                action: "执行用例".to_string(),
                system_id: "s1".to_string(),
                system_name: "svc".to_string(),
                api_id: "a1".to_string(),
                target: "GET /a".to_string(),
                detail: "成功".to_string(),
                result: "ok".to_string(),
            },
        )
        .unwrap();
        write_library(&conn, &sample()).unwrap();
        let rows = query_logs(&conn, "run", "GET /a", "", 0, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].result, "ok");
        assert!(query_logs(&conn, "create", "", "", 0, 0).unwrap().is_empty());
        assert_eq!(query_logs(&conn, "", "", "s1", 0, 0).unwrap().len(), 1);
        assert!(query_logs(&conn, "", "", "missing", 0, 0).unwrap().is_empty());
        conn.execute("UPDATE logs SET at = 1000", ()).unwrap();
        assert_eq!(query_logs(&conn, "", "", "", 500, 1500).unwrap().len(), 1);
        assert!(query_logs(&conn, "", "", "", 5000, 9000).unwrap().is_empty());
        append_log(
            &conn,
            &NewLog {
                category: "update".to_string(),
                action: "修改接口".to_string(),
                system_id: "s2".to_string(),
                system_name: "other".to_string(),
                api_id: "a2".to_string(),
                target: "GET /b".to_string(),
                detail: String::new(),
                result: String::new(),
            },
        )
        .unwrap();
        assert_eq!(clear_logs(&conn, "", "", "s1", 0, 0).unwrap(), 1);
        assert!(query_logs(&conn, "", "", "s1", 0, 0).unwrap().is_empty());
        assert_eq!(query_logs(&conn, "", "", "s2", 0, 0).unwrap().len(), 1);
        delete_related_logs(&conn, "", "a2").unwrap();
        assert!(query_logs(&conn, "", "", "", 0, 0).unwrap().is_empty());
        drop(conn);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
