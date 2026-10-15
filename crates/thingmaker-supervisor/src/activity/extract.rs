//! Only structured provider facts and the known apply_patch grammar count as file targets.
use crate::acp::updates::ToolPatch;
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

pub fn normalise(root: &Path, cwd: Option<&str>, raw: &str) -> Option<(String, bool)> {
    if raw.is_empty() || raw.len() > 4096 || raw.contains('\0') || raw.contains("://") {
        return None;
    }
    let raw = raw.replace('\\', "/");
    let base = cwd
        .map(PathBuf::from)
        .map(|p| if p.is_absolute() { p } else { root.join(p) })
        .unwrap_or_else(|| root.to_path_buf());
    let path = Path::new(&raw);
    let joined = if path.is_absolute() || raw.as_bytes().get(1) == Some(&b':') {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    let mut clean = PathBuf::new();
    for part in joined.components() {
        match part {
            Component::ParentDir => {
                clean.pop();
            }
            Component::CurDir => {}
            _ => clean.push(part.as_os_str()),
        }
    }
    let clean = std::fs::canonicalize(&clean).unwrap_or(clean);
    if clean.is_dir() {
        return None;
    }
    let outside = !clean.starts_with(root);
    let display = clean
        .strip_prefix(root)
        .unwrap_or(&clean)
        .to_string_lossy()
        .replace('\\', "/");
    if display.is_empty() {
        None
    } else {
        Some((display, outside))
    }
}

pub fn targets(tool: &ToolPatch, root: &Path) -> Vec<(String, bool, String)> {
    let input = tool.raw_input.as_ref().unwrap_or(&Value::Null);
    let name = tool.name.as_deref().unwrap_or("").to_lowercase();
    let kind = tool.kind.as_deref().unwrap_or("");
    let operation = if kind == "edit"
        || [
            "write",
            "edit",
            "apply_patch",
            "write_file",
            "writefile",
            "replace",
            "replace_in_file",
            "filechange",
        ]
        .contains(&name.as_str())
    {
        "edit"
    } else {
        "read"
    };
    let mut raw: Vec<(String, String)> = Vec::new();
    if let Some(locations) = tool.locations.as_ref().and_then(Value::as_array) {
        for item in locations.iter().take(64) {
            if let Some(path) = item.get("path").and_then(Value::as_str) {
                raw.push((path.into(), operation.into()));
            }
        }
    }
    let recognised = matches!(kind, "read" | "edit" | "search")
        || [
            "read",
            "read_file",
            "readfile",
            "write",
            "write_file",
            "writefile",
            "edit",
            "replace",
            "replace_in_file",
            "apply_patch",
            "filechange",
        ]
        .contains(&name.as_str());
    if recognised {
        for key in [
            "file_path",
            "filePath",
            "path",
            "absolute_path",
            "TargetFile",
            "AbsolutePath",
        ] {
            if kind == "search" && key == "path" {
                continue;
            }
            if let Some(path) = input.get(key).and_then(Value::as_str) {
                raw.push((path.into(), operation.into()));
            }
        }
        if let Some(changes) = input.get("changes").and_then(Value::as_array) {
            for change in changes.iter().take(64) {
                if let Some(path) = change.get("path").and_then(Value::as_str) {
                    let deletion = change.get("kind").is_some_and(|k| {
                        k.as_str() == Some("delete")
                            || k.get("delete").is_some()
                            || k.get("type").and_then(Value::as_str) == Some("delete")
                    });
                    raw.push((path.into(), if deletion { "delete" } else { "edit" }.into()));
                }
            }
        }
        if name == "apply_patch" {
            let patch = input
                .as_str()
                .or_else(|| input.get("patch").and_then(Value::as_str))
                .unwrap_or("");
            let mut last_update: Option<usize> = None;
            for line in patch.lines().take(5000) {
                if let Some(path) = line.strip_prefix("*** Move to: ") {
                    if let Some(index) = last_update.take() {
                        raw[index].1 = "delete".into();
                    }
                    raw.push((path.into(), "edit".into()));
                    continue;
                }
                for (prefix, action) in [
                    ("*** Update File: ", "edit"),
                    ("*** Add File: ", "edit"),
                    ("*** Delete File: ", "delete"),
                ] {
                    if let Some(path) = line.strip_prefix(prefix) {
                        if action == "edit" {
                            last_update = Some(raw.len());
                        } else {
                            last_update = None;
                        }
                        raw.push((path.into(), action.into()));
                    }
                }
            }
        }
    }
    if let Some(actions) = input.get("actions").and_then(Value::as_array) {
        for action in actions.iter().take(64) {
            if action.get("type").and_then(Value::as_str) == Some("read")
                && let Some(path) = action.get("path").and_then(Value::as_str)
            {
                raw.push((path.into(), "read".into()));
            }
        }
    }
    let cwd = input.get("cwd").and_then(Value::as_str);
    let mut result = Vec::new();
    for (path, action) in raw.into_iter().take(64) {
        if let Some((path, external)) = normalise(root, cwd, &path)
            && !result.iter().any(|(p, _, _)| p == &path)
        {
            result.push((path, external, action));
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn tool(value: Value) -> ToolPatch {
        ToolPatch::from_object(value.as_object().unwrap())
    }
    #[test]
    fn structured_changes_and_paths_resolve_against_cwd() {
        let t = tool(
            json!({"name":"apply_patch", "kind":"edit", "rawInput":{"cwd":"src", "changes":[{"path":"../a.ts","kind":"delete"},{"path":"b.ts","kind":"add"}]}}),
        );
        assert_eq!(
            targets(&t, Path::new("/repo")),
            vec![
                ("a.ts".into(), false, "delete".into()),
                ("src/b.ts".into(), false, "edit".into())
            ]
        );
    }
    #[test]
    fn prose_and_arbitrary_mcp_data_are_not_activity() {
        assert!(targets(&tool(json!({"name":"chat", "rawInput":{"path":"imaginary.ts"},"rawOutput":"I edited actual.ts"})), Path::new("/repo")).is_empty());
        assert_eq!(
            normalise(Path::new("/repo"), None, "../../etc/passwd"),
            Some((
                std::fs::canonicalize("/etc/passwd")
                    .unwrap_or_else(|_| PathBuf::from("/etc/passwd"))
                    .to_string_lossy()
                    .into(),
                true
            ))
        );
    }
    #[test]
    fn a_patch_rename_keeps_both_source_and_destination() {
        let t = tool(
            json!({"name":"apply_patch","rawInput":"*** Update File: old.rs\n*** Move to: new.rs\n@@\n-old\n+new"}),
        );
        assert_eq!(
            targets(&t, Path::new("/repo")),
            vec![
                ("old.rs".into(), false, "delete".into()),
                ("new.rs".into(), false, "edit".into())
            ]
        );
    }
    #[test]
    fn reads_and_patch_grammar_are_recognised() {
        let t = tool(json!({"name":"Read","rawInput":{"file_path":"/repo/a.rs"}}));
        assert_eq!(targets(&t, Path::new("/repo"))[0].2, "read");
        let t = tool(
            json!({"name":"apply_patch","rawInput":"*** Begin Patch\n*** Add File: x.rs\n+hi\n*** End Patch"}),
        );
        assert_eq!(targets(&t, Path::new("/repo"))[0].0, "x.rs");
    }
}
