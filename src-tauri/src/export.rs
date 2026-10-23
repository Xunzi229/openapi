use crate::model::System;

fn case_title(content: &str) -> Option<String> {
    content
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with('#'))
        .map(|line| line.trim_start_matches('#').trim().to_string())
        .filter(|title| !title.is_empty())
}

pub fn system_markdown(system: &System) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", system.name));
    if !system.note.trim().is_empty() {
        out.push_str(system.note.trim());
        out.push_str("\n\n");
    }
    let envs: Vec<_> = system.links.iter().filter(|link| link.kind == "env").collect();
    if !envs.is_empty() {
        out.push_str("## 环境\n\n");
        for link in envs {
            out.push_str(&format!("- {}", link.label));
            if !link.host.is_empty() {
                out.push_str(&format!(" `{}`", link.host));
            }
            if !link.url.is_empty() {
                out.push_str(&format!(" [发布页]({})", link.url));
            }
            if !link.note.is_empty() {
                out.push_str(&format!(" {}", link.note));
            }
            out.push('\n');
        }
        out.push('\n');
    }
    let docs: Vec<_> = system.links.iter().filter(|link| link.kind != "env").collect();
    if !docs.is_empty() {
        out.push_str("## 链接\n\n");
        for link in docs {
            out.push_str(&format!("- [{}]({})", link.label, link.url));
            if !link.note.is_empty() {
                out.push_str(&format!(" {}", link.note));
            }
            out.push('\n');
        }
        out.push('\n');
    }
    if !system.variables.is_empty() {
        out.push_str("## 变量\n\n");
        for variable in &system.variables {
            let value = if variable.secret { "***" } else { variable.value.as_str() };
            let scope = if variable.env_id.is_empty() {
                "全局".to_string()
            } else {
                system
                    .links
                    .iter()
                    .find(|link| link.id == variable.env_id)
                    .map(|link| link.label.clone())
                    .unwrap_or_else(|| "环境".to_string())
            };
            out.push_str(&format!("- {scope} `{{{{{}}}}}` = `{}`\n", variable.name, value));
        }
        out.push('\n');
    }
    for api in &system.apis {
        out.push_str(&format!("## {} {}\n\n", api.method, api.path));
        if !api.group.trim().is_empty() {
            out.push_str(&format!("分组：{}\n\n", api.group.trim()));
        }
        if !api.note.trim().is_empty() {
            out.push_str(api.note.trim());
            out.push_str("\n\n");
        }
        for case in &api.cases {
            if let Some(title) = case_title(&case.content) {
                out.push_str(&format!("### {title}\n\n"));
            }
            out.push_str("```bash\n");
            out.push_str(case.content.trim_end());
            out.push_str("\n```\n\n");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ApiEntry, Case, Link, Variable};

    #[test]
    fn writes_fenced_curls() {
        let system = System {
            id: "s".to_string(),
            name: "svc".to_string(),
            domain: "其他".to_string(),
            note: "说明".to_string(),
            groups: Vec::new(),
            links: vec![Link {
                id: "l".to_string(),
                label: "TE".to_string(),
                url: "https://paas/x?env=TE".to_string(),
                kind: "env".to_string(),
                host: "https://svc.te".to_string(),
                note: String::new(),
            }],
            variables: vec![Variable {
                id: "v".to_string(),
                name: "token".to_string(),
                value: "abc".to_string(),
                secret: true,
                env_id: String::new(),
            }],
            apis: vec![ApiEntry::new("POST", "/a", vec![Case::new("# 标题\ncurl 'https://svc.te/a'".to_string())])],
        };
        let text = system_markdown(&system);
        assert!(text.contains("## POST /a"));
        assert!(text.contains("### 标题"));
        assert!(text.contains("```bash\n# 标题\ncurl"));
        assert!(text.contains("`{{token}}` = `***`"));
    }
}
