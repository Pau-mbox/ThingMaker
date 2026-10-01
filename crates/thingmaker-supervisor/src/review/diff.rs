//! Diffs between a baseline and the current working tree (REV-01, REV-02).
//!
//! Additions, deletions, modifications, renames (same content, new path),
//! mode changes and binary changes are reported. Unified diffs are produced
//! for retained text files and bounded in size; anything not diffable says so
//! explicitly instead of disappearing.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use similar::TextDiff;

use super::baseline::{BaselineManifest, ContentState};
use super::blobs::BlobStore;
use crate::error::DesktopError;

pub const MAX_UNIFIED_BYTES: usize = 512 * 1024;
pub const MAX_CHANGES: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    ModeChanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub kind: ChangeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub renamed_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_hash: Option<String>,
    pub before_bytes: u64,
    pub after_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_mode: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_mode: Option<u32>,
    pub binary: bool,
    /// Present when a text diff could be produced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unified: Option<String>,
    /// Why no unified diff is shown (binary, too large, content not retained).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub omitted: Option<String>,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffReport {
    pub scope: String,
    pub label: String,
    pub base_ref: String,
    pub files: Vec<FileChange>,
    pub truncated: bool,
    pub computed_at_unix_ms: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Unified diff of two texts with three lines of context, bounded.
pub fn unified_diff(path: &str, before: &str, after: &str) -> (Option<String>, usize, usize) {
    let diff = TextDiff::from_lines(before, after);
    let mut additions = 0;
    let mut deletions = 0;
    for change in diff.iter_all_changes() {
        match change.tag() {
            similar::ChangeTag::Insert => additions += 1,
            similar::ChangeTag::Delete => deletions += 1,
            similar::ChangeTag::Equal => {}
        }
    }
    let text = diff
        .unified_diff()
        .context_radius(3)
        .header(&format!("a/{path}"), &format!("b/{path}"))
        .to_string();
    if text.len() > MAX_UNIFIED_BYTES {
        return (None, additions, deletions);
    }
    (Some(text), additions, deletions)
}

/// Compares `current` (a fresh capture) against `baseline`.
pub fn diff_against_baseline(
    baseline: &BaselineManifest,
    current: &BaselineManifest,
    blobs: &BlobStore,
    scope: &str,
    label: &str,
    base_ref: &str,
) -> Result<DiffReport, DesktopError> {
    let mut files = Vec::new();
    let mut deleted: BTreeMap<&str, &super::baseline::BaselineFile> = BTreeMap::new();
    for (path, before) in &baseline.files {
        if !current.files.contains_key(path) {
            deleted.insert(path, before);
        }
    }
    let mut renamed_targets = std::collections::HashSet::new();
    let mut truncated = false;
    for (path, after) in &current.files {
        if files.len() >= MAX_CHANGES {
            truncated = true;
            break;
        }
        match baseline.files.get(path) {
            None => {
                // Same content that vanished elsewhere is a rename.
                let source = deleted.iter().find(|(_, before)| before.hash == after.hash).map(|(p, _)| p.to_string());
                if let Some(from) = source {
                    renamed_targets.insert(from.clone());
                    files.push(FileChange {
                        path: path.clone(),
                        kind: ChangeKind::Renamed,
                        renamed_from: Some(from),
                        before_hash: Some(after.hash.clone()),
                        after_hash: Some(after.hash.clone()),
                        before_bytes: after.bytes,
                        after_bytes: after.bytes,
                        before_mode: after.mode,
                        after_mode: after.mode,
                        binary: after.content == ContentState::Binary,
                        unified: None,
                        omitted: None,
                        additions: 0,
                        deletions: 0,
                    });
                    continue;
                }
                let (unified, omitted, additions) = match text_of(blobs, after)? {
                    Some(text) if after.content != ContentState::Binary => {
                        let (u, a, _) = unified_diff(path, "", &text);
                        let too_large = u.is_none();
                        (u, if too_large { Some("diff too large".to_string()) } else { None }, a)
                    }
                    _ => (None, omission(after), 0),
                };
                files.push(FileChange {
                    path: path.clone(),
                    kind: ChangeKind::Added,
                    renamed_from: None,
                    before_hash: None,
                    after_hash: Some(after.hash.clone()),
                    before_bytes: 0,
                    after_bytes: after.bytes,
                    before_mode: None,
                    after_mode: after.mode,
                    binary: after.content == ContentState::Binary,
                    unified,
                    omitted,
                    additions,
                    deletions: 0,
                });
            }
            Some(before) if before.hash != after.hash => {
                let binary = before.content == ContentState::Binary || after.content == ContentState::Binary;
                let (unified, omitted, additions, deletions) = match (text_of(blobs, before)?, text_of(blobs, after)?) {
                    (Some(b), Some(a)) if !binary => {
                        let (u, add, del) = unified_diff(path, &b, &a);
                        let too_large = u.is_none();
                        (u, if too_large { Some("diff too large".to_string()) } else { None }, add, del)
                    }
                    _ => (None, Some(omission(before).or_else(|| omission(after)).unwrap_or_else(|| "content not retained".into())), 0, 0),
                };
                files.push(FileChange {
                    path: path.clone(),
                    kind: ChangeKind::Modified,
                    renamed_from: None,
                    before_hash: Some(before.hash.clone()),
                    after_hash: Some(after.hash.clone()),
                    before_bytes: before.bytes,
                    after_bytes: after.bytes,
                    before_mode: before.mode,
                    after_mode: after.mode,
                    binary,
                    unified,
                    omitted,
                    additions,
                    deletions,
                });
            }
            Some(before) if before.mode != after.mode => files.push(FileChange {
                path: path.clone(),
                kind: ChangeKind::ModeChanged,
                renamed_from: None,
                before_hash: Some(before.hash.clone()),
                after_hash: Some(after.hash.clone()),
                before_bytes: before.bytes,
                after_bytes: after.bytes,
                before_mode: before.mode,
                after_mode: after.mode,
                binary: false,
                unified: None,
                omitted: None,
                additions: 0,
                deletions: 0,
            }),
            Some(_) => {}
        }
    }
    for (path, before) in deleted {
        if renamed_targets.contains(path) {
            continue;
        }
        if files.len() >= MAX_CHANGES {
            truncated = true;
            break;
        }
        let (unified, deletions) = match text_of(blobs, before)? {
            Some(text) if before.content != ContentState::Binary => {
                let (u, _, d) = unified_diff(path, &text, "");
                (u, d)
            }
            _ => (None, 0),
        };
        files.push(FileChange {
            path: path.to_string(),
            kind: ChangeKind::Deleted,
            renamed_from: None,
            before_hash: Some(before.hash.clone()),
            after_hash: None,
            before_bytes: before.bytes,
            after_bytes: 0,
            before_mode: before.mode,
            after_mode: None,
            binary: before.content == ContentState::Binary,
            unified,
            omitted: omission(before),
            additions: 0,
            deletions,
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(DiffReport {
        scope: scope.to_string(),
        label: label.to_string(),
        base_ref: base_ref.to_string(),
        files,
        truncated,
        computed_at_unix_ms: now_ms(),
    })
}

fn omission(file: &super::baseline::BaselineFile) -> Option<String> {
    match file.content {
        ContentState::Retained => None,
        ContentState::TooLarge => Some("file too large to retain".into()),
        ContentState::Binary => Some("binary file".into()),
    }
}

fn text_of(blobs: &BlobStore, file: &super::baseline::BaselineFile) -> Result<Option<String>, DesktopError> {
    if file.content != ContentState::Retained {
        return Ok(None);
    }
    Ok(blobs.get(&file.hash)?.map(|bytes| String::from_utf8_lossy(&bytes).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::baseline::capture_baseline;
    use std::fs;

    #[test]
    fn reports_added_modified_deleted_renamed_and_binary_changes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("ws");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("keep.txt"), "same\n").unwrap();
        fs::write(root.join("edit.txt"), "line one\nline two\n").unwrap();
        fs::write(root.join("gone.txt"), "bye\n").unwrap();
        fs::write(root.join("move.txt"), "moving\n").unwrap();
        fs::write(root.join("pic.bin"), [0u8, 1, 2]).unwrap();
        let blobs = BlobStore::new(temp.path().join("blobs"));
        let baseline = capture_baseline(&root, &blobs).unwrap();

        fs::write(root.join("edit.txt"), "line one\nline 2\nline three\n").unwrap();
        fs::remove_file(root.join("gone.txt")).unwrap();
        fs::rename(root.join("move.txt"), root.join("moved.txt")).unwrap();
        fs::write(root.join("new.txt"), "brand new\n").unwrap();
        fs::write(root.join("pic.bin"), [0u8, 9, 9]).unwrap();
        let current = capture_baseline(&root, &blobs).unwrap();
        let report = diff_against_baseline(&baseline, &current, &blobs, "session_baseline", "Session baseline", "test").unwrap();
        let by_path: BTreeMap<&str, &FileChange> = report.files.iter().map(|f| (f.path.as_str(), f)).collect();
        assert_eq!(by_path.len(), 5, "{:?}", by_path.keys());
        assert_eq!(by_path["edit.txt"].kind, ChangeKind::Modified);
        assert_eq!((by_path["edit.txt"].additions, by_path["edit.txt"].deletions), (2, 1));
        assert!(by_path["edit.txt"].unified.as_ref().unwrap().contains("-line two\n+line 2\n+line three"));
        assert_eq!(by_path["gone.txt"].kind, ChangeKind::Deleted);
        assert_eq!(by_path["gone.txt"].deletions, 1);
        assert_eq!(by_path["moved.txt"].kind, ChangeKind::Renamed);
        assert_eq!(by_path["moved.txt"].renamed_from.as_deref(), Some("move.txt"));
        assert!(!by_path.contains_key("move.txt"));
        assert_eq!(by_path["new.txt"].kind, ChangeKind::Added);
        assert_eq!(by_path["new.txt"].additions, 1);
        assert!(by_path["pic.bin"].binary);
        assert_eq!(by_path["pic.bin"].omitted.as_deref(), Some("binary file"));
        assert!(by_path["pic.bin"].unified.is_none());
        assert!(!by_path.contains_key("keep.txt"));
    }
}
