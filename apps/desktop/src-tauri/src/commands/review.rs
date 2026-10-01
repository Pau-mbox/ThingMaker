//! Files and review commands (FS-01..03, REV-01, REV-02).
//!
//! Browsing and reading never execute anything and work for every trust
//! state. Writes require an explicit trust decision (trusted local or inspect
//! only) and a matching content hash. Baselines are captured per session so
//! agent work can be reviewed against the tree as it was when the session
//! opened, Git or not.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;
use thingmaker_supervisor::{
    DesktopError,
    review::{
        BlobStore, ChangeKind, DiffReport, FileChange, capture_baseline, diff_against_baseline, git_diff, git_head,
        git_status, is_git_repository,
    },
    storage::{review::BaselineRecord, workspaces::{TrustState, WorkspaceRecord}},
    workspace::{DirEntry, FileRead, WriteOutcome, list_dir, read_text, write_checked},
};

use super::{CommandResult, storage_error};
use crate::state::AppState;

fn workspace(state: &AppState, workspace_id: &str) -> CommandResult<WorkspaceRecord> {
    state
        .with_storage(|storage| storage.workspace_get(workspace_id))
        .map_err(storage_error)?
        .ok_or_else(|| DesktopError::not_ready("workspace not found"))
}

fn blobs(state: &AppState) -> BlobStore {
    BlobStore::new(state.data_dir.join("blobs"))
}

#[tauri::command]
pub fn workspace_list_dir(workspace_id: String, relative: String, show_ignored: bool, state: State<'_, AppState>) -> CommandResult<Vec<DirEntry>> {
    let record = workspace(&state, &workspace_id)?;
    list_dir(Path::new(&record.canonical_root), &relative, show_ignored)
}

#[tauri::command]
pub fn file_read(workspace_id: String, relative: String, offset_line: usize, limit: usize, state: State<'_, AppState>) -> CommandResult<FileRead> {
    let record = workspace(&state, &workspace_id)?;
    read_text(Path::new(&record.canonical_root), &relative, offset_line, limit.clamp(1, 20_000))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteRequest {
    pub workspace_id: String,
    pub relative: String,
    pub expected_hash: Option<String>,
    pub content: String,
}

#[tauri::command]
pub fn file_write_checked(request: WriteRequest, state: State<'_, AppState>) -> CommandResult<WriteOutcome> {
    let record = workspace(&state, &request.workspace_id)?;
    if record.trust_state == TrustState::Untrusted {
        return Err(DesktopError::untrusted("Review the workspace and choose an execution profile before editing files from the desktop."));
    }
    write_checked(Path::new(&record.canonical_root), &request.relative, request.expected_hash.as_deref(), &request.content)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    pub workspace_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
}

pub fn capture_for(state: &AppState, workspace_id: &str, session_id: Option<&str>, scope: &str) -> CommandResult<BaselineRecord> {
    let record = workspace(state, workspace_id)?;
    let root = Path::new(&record.canonical_root);
    let manifest = capture_baseline(root, &blobs(state))?;
    let base_ref = if is_git_repository(root) { git_head(root).ok() } else { None };
    let desktop_session = session_id.and_then(|kit_id| {
        state
            .with_storage(|storage| storage.session_by_agent_id(&record.id, kit_id))
            .ok()
            .flatten()
            .map(|s| s.id)
    });
    state
        .with_storage(|storage| storage.baseline_insert(&record.id, desktop_session.as_deref(), scope, base_ref.as_deref(), &manifest))
        .map_err(storage_error)
}

/// Captures a content-addressed baseline of the workspace now.
#[tauri::command]
pub async fn review_capture_baseline(request: CaptureRequest, state: State<'_, AppState>) -> CommandResult<BaselineRecord> {
    let scope = request.scope.unwrap_or_else(|| "session_baseline".into());
    capture_for(&state, &request.workspace_id, request.session_id.as_deref(), &scope)
}

#[tauri::command]
pub fn review_baselines(workspace_id: String, state: State<'_, AppState>) -> CommandResult<Vec<BaselineRecord>> {
    state.with_storage(|storage| storage.baseline_list(&workspace_id, 50)).map_err(storage_error)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffScope {
    /// Working tree versus a captured baseline (no Git required).
    Baseline,
    /// Git working tree versus the index (plus untracked files).
    WorkingTree,
    /// Git index versus HEAD.
    Staged,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRequest {
    pub workspace_id: String,
    pub scope: DiffScope,
    /// Baseline id for the baseline scope; the newest for the workspace (or
    /// session when given) is used otherwise.
    #[serde(default)]
    pub baseline_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResponse {
    pub report: DiffReport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline: Option<BaselineRecord>,
    pub is_git_repository: bool,
}

fn git_kind(index: &str, worktree: &str, untracked: bool) -> ChangeKind {
    if untracked {
        return ChangeKind::Added;
    }
    match (index, worktree) {
        ("A", _) | (_, "A") => ChangeKind::Added,
        ("D", _) | (_, "D") => ChangeKind::Deleted,
        ("R", _) | (_, "R") => ChangeKind::Renamed,
        ("T", _) | (_, "T") => ChangeKind::ModeChanged,
        _ => ChangeKind::Modified,
    }
}

fn count_lines(unified: &str) -> (usize, usize) {
    let mut additions = 0;
    let mut deletions = 0;
    for line in unified.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }
    (additions, deletions)
}

fn git_report(root: &Path, staged: bool) -> CommandResult<DiffReport> {
    let entries = git_status(root)?;
    let head = git_head(root).unwrap_or_else(|_| "HEAD".into());
    let mut files = Vec::new();
    for entry in entries.into_iter().take(500) {
        let relevant = if staged { entry.index != " " && entry.index != "?" } else { entry.worktree != " " || entry.untracked };
        if !relevant {
            continue;
        }
        let (unified, omitted, additions, deletions) = if entry.untracked && !staged {
            match read_text(root, &entry.path, 0, 20_000) {
                Ok(read) if !read.binary => {
                    let (u, a, _) = thingmaker_supervisor::review::diff::unified_diff(&entry.path, "", &read.content);
                    (u, None, a, 0)
                }
                Ok(_) => (None, Some("binary file".to_string()), 0, 0),
                Err(error) => (None, Some(error.message), 0, 0),
            }
        } else {
            let text = git_diff(root, staged, Some(&entry.path))?;
            if text.is_empty() {
                (None, Some("no textual diff (binary or mode-only change)".to_string()), 0, 0)
            } else if text.len() > thingmaker_supervisor::review::diff::MAX_UNIFIED_BYTES {
                (None, Some("diff too large".to_string()), 0, 0)
            } else {
                let (a, d) = count_lines(&text);
                (Some(text), None, a, d)
            }
        };
        files.push(FileChange {
            kind: git_kind(&entry.index, &entry.worktree, entry.untracked),
            path: entry.path,
            renamed_from: entry.renamed_from,
            before_hash: None,
            after_hash: None,
            before_bytes: 0,
            after_bytes: 0,
            before_mode: None,
            after_mode: None,
            binary: omitted.as_deref() == Some("binary file"),
            unified,
            omitted,
            additions,
            deletions,
        });
    }
    Ok(DiffReport {
        scope: if staged { "staged".into() } else { "working_tree".into() },
        label: if staged { "Staged versus HEAD".into() } else { "Working tree versus index".into() },
        base_ref: head,
        files,
        truncated: false,
        computed_at_unix_ms: thingmaker_supervisor::storage::now_unix_ms() as u64,
    })
}

#[tauri::command]
pub async fn review_diff(request: DiffRequest, state: State<'_, AppState>) -> CommandResult<DiffResponse> {
    let record = workspace(&state, &request.workspace_id)?;
    let root = Path::new(&record.canonical_root).to_path_buf();
    let git = is_git_repository(&root);
    match request.scope {
        DiffScope::Baseline => {
            let baseline = match &request.baseline_id {
                Some(id) => state.with_storage(|s| s.baseline_get(id)).map_err(storage_error)?,
                None => {
                    let desktop_session = request.session_id.as_deref().and_then(|kit_id| {
                        state.with_storage(|s| s.session_by_agent_id(&record.id, kit_id)).ok().flatten().map(|s| s.id)
                    });
                    let latest = state
                        .with_storage(|s| s.baseline_latest(&record.id, desktop_session.as_deref()))
                        .map_err(storage_error)?;
                    match latest {
                        Some(latest) => state.with_storage(|s| s.baseline_get(&latest.id)).map_err(storage_error)?,
                        None => None,
                    }
                }
            };
            let Some((baseline_record, manifest)) = baseline else {
                return Err(DesktopError::not_ready("No baseline exists for this workspace yet. Capture one first."));
            };
            let store = blobs(&state);
            let current = capture_baseline(&root, &store)?;
            let label = format!("Working tree versus baseline captured {}", baseline_record.created_at);
            let report = diff_against_baseline(&manifest, &current, &store, "session_baseline", &label, baseline_record.base_ref.as_deref().unwrap_or("no Git ref"))?;
            Ok(DiffResponse { report, baseline: Some(baseline_record), is_git_repository: git })
        }
        DiffScope::WorkingTree | DiffScope::Staged => {
            if !git {
                return Err(DesktopError::unsupported("This workspace is not a Git repository; use the baseline scope."));
            }
            let report = git_report(&root, request.scope == DiffScope::Staged)?;
            Ok(DiffResponse { report, baseline: None, is_git_repository: true })
        }
    }
}


#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImage {
    pub relative: String,
    pub absolute_path: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub data_base64: String,
    /// Content Credentials generator for PNGs that carry a C2PA manifest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credentials: Option<thingmaker_supervisor::c2pa::ContentCredentials>,
}

/// A workspace image for inline display: contained path, sniffed type,
/// decoded dimensions and size limits checked before any bytes reach the page.
#[tauri::command]
pub fn workspace_image(workspace_id: String, relative: String, state: State<'_, AppState>) -> CommandResult<WorkspaceImage> {
    let record = workspace(&state, &workspace_id)?;
    let root = Path::new(&record.canonical_root);
    let path = thingmaker_supervisor::workspace::explorer::resolve_contained(root, &relative)?;
    read_image(&path, relative)
}

/// An image Codex's image tool saved, for inline display in the transcript.
///
/// Codex keeps generated images under `$CODEX_HOME/generated_images`, outside
/// any workspace. Only files inside that directory are read, after resolving
/// links, with the same checks as a workspace image.
#[tauri::command]
pub fn generated_image(path: String, state: State<'_, AppState>) -> CommandResult<WorkspaceImage> {
    let home = state.home.clone().ok_or_else(|| DesktopError::not_ready("HOME is not set"))?;
    let codex_home = std::env::var_os("CODEX_HOME").map(std::path::PathBuf::from).unwrap_or_else(|| home.join(".codex"));
    let allowed = std::fs::canonicalize(codex_home.join("generated_images")).map_err(|_| DesktopError::not_ready("Codex has not generated any images here"))?;
    let resolved = std::fs::canonicalize(&path).map_err(|e| DesktopError::io(format!("{path}: {e}")))?;
    if !resolved.starts_with(&allowed) {
        return Err(DesktopError::untrusted("only images Codex generated can be read outside the workspace"));
    }
    let label = resolved.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or(path);
    read_image(&resolved, label)
}

fn read_image(path: &Path, relative: String) -> CommandResult<WorkspaceImage> {
    use thingmaker_supervisor::attachments::{MAX_IMAGE_PIXELS, MediaKind, image_dimensions, sniff_media};
    let metadata = std::fs::metadata(path).map_err(|e| DesktopError::io(format!("{relative}: {e}")))?;
    if !metadata.is_file() {
        return Err(DesktopError::io("not a regular file"));
    }
    if metadata.len() > 10 * 1024 * 1024 {
        return Err(DesktopError::limit_exceeded("image exceeds 10 MiB; open it externally"));
    }
    let bytes = std::fs::read(path).map_err(|e| DesktopError::io(e.to_string()))?;
    let Some((MediaKind::Image, mime)) = sniff_media(&bytes) else {
        return Err(DesktopError::unsupported("not a PNG, JPEG, GIF or WebP image"));
    };
    let (width, height) = image_dimensions(&bytes, mime).ok_or_else(|| DesktopError::io("image header could not be decoded"))?;
    if u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS || width == 0 || height == 0 {
        return Err(DesktopError::limit_exceeded("image dimensions are outside the accepted range"));
    }
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    Ok(WorkspaceImage {
        relative,
        absolute_path: path.to_string_lossy().into_owned(),
        mime: mime.into(),
        width,
        height,
        bytes: metadata.len(),
        credentials: if mime == "image/png" { thingmaker_supervisor::c2pa::content_credentials(&bytes) } else { None },
        data_base64: out,
    })
}
