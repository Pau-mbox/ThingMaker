//! Lazy, ignore-aware directory listing (FS-01, FS-02).
//!
//! Paths are workspace-relative and re-validated against the canonical root on
//! every call so a renderer can never address files outside the workspace.
//! Ignore rules (`.gitignore`, `.ignore`, global excludes) are presentation
//! filters only: hiding a file here never hides it from an agent.

use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};

use crate::error::DesktopError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// Forward-slash relative path from the workspace root.
    pub relative_path: String,
    pub kind: EntryKind,
    pub bytes: u64,
    pub ignored: bool,
    pub hidden: bool,
    pub modified_unix_ms: Option<u64>,
}

/// Resolves a workspace-relative path and proves containment. Rejects `..`,
/// absolute paths and symlink escapes (the final path is canonicalized when it
/// exists).
pub fn resolve_contained(root: &Path, relative: &str) -> Result<PathBuf, DesktopError> {
    let rel = Path::new(relative);
    if rel.is_absolute() {
        return Err(DesktopError::io("path must be workspace-relative"));
    }
    let mut joined = root.to_path_buf();
    for component in rel.components() {
        match component {
            Component::Normal(part) => joined.push(part),
            Component::CurDir => {}
            _ => return Err(DesktopError::io("path escapes the workspace")),
        }
    }
    let canonical_root = fs::canonicalize(root).map_err(|e| DesktopError::io(e.to_string()))?;
    let check = if joined.exists() {
        fs::canonicalize(&joined).map_err(|e| DesktopError::io(e.to_string()))?
    } else {
        // New files: the parent must exist and be contained.
        let parent = joined.parent().ok_or_else(|| DesktopError::io("invalid path"))?;
        let canonical_parent = fs::canonicalize(parent).map_err(|e| DesktopError::io(format!("parent missing: {e}")))?;
        canonical_parent.join(joined.file_name().ok_or_else(|| DesktopError::io("invalid path"))?)
    };
    if !check.starts_with(&canonical_root) {
        return Err(DesktopError::io("path escapes the workspace"));
    }
    Ok(check)
}

fn relative_string(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .filter_map(|c| match c {
            Component::Normal(p) => Some(p.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Lists one directory level. With `show_ignored` false, ignored entries are
/// omitted; otherwise they are included and flagged.
pub fn list_dir(root: &Path, relative: &str, show_ignored: bool) -> Result<Vec<DirEntry>, DesktopError> {
    let dir = resolve_contained(root, relative)?;
    if !dir.is_dir() {
        return Err(DesktopError::io("not a directory"));
    }
    let canonical_root = fs::canonicalize(root).map_err(|e| DesktopError::io(e.to_string()))?;
    let mut entries = Vec::new();
    // `ignore` needs to see the ancestors to apply nested .gitignore files, so
    // walk from the root with the target dir as a filter is expensive; instead
    // build the walker rooted at `dir` with parents enabled.
    let walker = WalkBuilder::new(&dir)
        .max_depth(Some(1))
        .hidden(false)
        .parents(true)
        .require_git(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .follow_links(false)
        .standard_filters(false)
        .build();
    // A second, filtered walk tells us which entries the ignore rules drop.
    let filtered: std::collections::HashSet<PathBuf> = WalkBuilder::new(&dir)
        .max_depth(Some(1))
        .hidden(false)
        .parents(true)
        .require_git(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .follow_links(false)
        .build()
        .filter_map(Result::ok)
        .map(|e| e.into_path())
        .collect();
    for entry in walker.filter_map(Result::ok) {
        let path = entry.path().to_path_buf();
        if path == dir {
            continue;
        }
        let ignored = !filtered.contains(&path);
        if ignored && !show_ignored {
            continue;
        }
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let metadata = fs::symlink_metadata(&path).ok();
        let kind = match &metadata {
            Some(m) if m.file_type().is_symlink() => EntryKind::Symlink,
            Some(m) if m.is_dir() => EntryKind::Dir,
            Some(m) if m.is_file() => EntryKind::File,
            _ => EntryKind::Other,
        };
        entries.push(DirEntry {
            relative_path: relative_string(&canonical_root, &path),
            hidden: name.starts_with('.'),
            bytes: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
            modified_unix_ms: metadata
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64),
            name,
            kind,
            ignored,
        });
    }
    entries.sort_by(|a, b| {
        let rank = |k: EntryKind| if k == EntryKind::Dir { 0 } else { 1 };
        rank(a.kind).cmp(&rank(b.kind)).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("target/debug")).unwrap();
        fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
        fs::write(root.join("notes.log"), "x").unwrap();
        fs::write(root.join("README.md"), "# hi\n").unwrap();
        fs::write(root.join("target/debug/bin"), "bin").unwrap();
        temp
    }

    #[test]
    fn lists_with_ignore_rules_and_flags_ignored_when_requested() {
        let temp = fixture();
        let visible = list_dir(temp.path(), "", false).unwrap();
        let names: Vec<&str> = visible.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["src", ".gitignore", "README.md"], "directories first, then case-insensitive names");
        let all = list_dir(temp.path(), "", true).unwrap();
        let mut ignored: Vec<&str> = all.iter().filter(|e| e.ignored).map(|e| e.name.as_str()).collect();
        ignored.sort();
        assert_eq!(ignored, ["notes.log", "target"]);
        assert!(all.iter().find(|e| e.name == "src").unwrap().kind == EntryKind::Dir);
        assert_eq!(all[0].kind, EntryKind::Dir, "directories sort first");
        let nested = list_dir(temp.path(), "src", false).unwrap();
        assert_eq!(nested[0].relative_path, "src/main.rs");
    }

    #[test]
    fn rejects_escapes_and_absolute_paths() {
        let temp = fixture();
        assert!(list_dir(temp.path(), "../", false).is_err());
        assert!(resolve_contained(temp.path(), "/etc").is_err());
        assert!(resolve_contained(temp.path(), "src/../../x").is_err());
        assert!(resolve_contained(temp.path(), "src/new.rs").is_ok());
        assert!(resolve_contained(temp.path(), "missing-dir/new.rs").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/", temp.path().join("escape")).unwrap();
            assert!(resolve_contained(temp.path(), "escape/etc").is_err());
        }
    }
}
