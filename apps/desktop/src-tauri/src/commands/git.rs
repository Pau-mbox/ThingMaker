//! Git review actions, worktrees and editor hand-off (REV-04/05, GIT-01..04,
//! EDT-01).
//!
//! Every mutation is explicit and named: stage/unstage/revert take paths or a
//! single hunk patch, revert requires the file's current hash, commit needs a
//! message and staged content, push targets a named remote and never forces.
//! Confirmation dialogs live in the renderer through `confirm_dialog`; the
//! native side still validates state (trust, live sessions) before acting.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;
use thingmaker_supervisor::{
    DesktopError,
    review::{self, BlobStore, RepositoryInfo, WorktreeEntry, capture_baseline},
    storage::{
        workspaces::{TrustState, WorkspaceRecord},
        worktrees::WorktreeRecord,
    },
    workspace::{WorkspaceIdentity, explorer::resolve_contained, read_text},
};

use super::{CommandResult, storage_error};
use crate::state::AppState;

fn workspace(state: &AppState, workspace_id: &str) -> CommandResult<WorkspaceRecord> {
    state
        .with_storage(|storage| storage.workspace_get(workspace_id))
        .map_err(storage_error)?
        .ok_or_else(|| DesktopError::not_ready("workspace not found"))
}

fn git_workspace(state: &AppState, workspace_id: &str) -> CommandResult<(WorkspaceRecord, PathBuf)> {
    let record = workspace(state, workspace_id)?;
    if record.trust_state == TrustState::Untrusted {
        return Err(DesktopError::untrusted("Choose an execution profile for this workspace before running Git operations from the desktop."));
    }
    let root = PathBuf::from(&record.canonical_root);
    if !review::is_git_repository(&root) {
        return Err(DesktopError::unsupported("This workspace is not a Git repository."));
    }
    Ok((record, root))
}

#[tauri::command]
pub fn git_info(workspace_id: String, state: State<'_, AppState>) -> CommandResult<RepositoryInfo> {
    let record = workspace(&state, &workspace_id)?;
    let root = PathBuf::from(&record.canonical_root);
    if !review::is_git_repository(&root) {
        return Err(DesktopError::unsupported("not a Git repository"));
    }
    review::repository_info(&root)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathsRequest {
    pub workspace_id: String,
    pub paths: Vec<String>,
}

#[tauri::command]
pub fn git_stage(request: PathsRequest, state: State<'_, AppState>) -> CommandResult<()> {
    let (_, root) = git_workspace(&state, &request.workspace_id)?;
    review::stage(&root, &request.paths)
}

#[tauri::command]
pub fn git_unstage(request: PathsRequest, state: State<'_, AppState>) -> CommandResult<()> {
    let (_, root) = git_workspace(&state, &request.workspace_id)?;
    review::unstage(&root, &request.paths)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertRequest {
    pub workspace_id: String,
    pub path: String,
    /// Hash of the file as shown in the diff; a mismatch aborts (stale review).
    pub expected_hash: String,
    pub untracked: bool,
}

#[tauri::command]
pub fn git_revert_file(request: RevertRequest, state: State<'_, AppState>) -> CommandResult<()> {
    let (_, root) = git_workspace(&state, &request.workspace_id)?;
    review::revert_file(&root, &request.path, &request.expected_hash, request.untracked)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkRequest {
    pub workspace_id: String,
    /// A complete single-file unified patch containing the hunk.
    pub patch: String,
    pub staged: bool,
    pub reverse: bool,
}

#[tauri::command]
pub fn git_apply_hunk(request: HunkRequest, state: State<'_, AppState>) -> CommandResult<()> {
    let (_, root) = git_workspace(&state, &request.workspace_id)?;
    review::apply_patch(&root, &request.patch, request.staged, request.reverse)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    pub workspace_id: String,
    pub message: String,
}

#[tauri::command]
pub fn git_commit(request: CommitRequest, state: State<'_, AppState>) -> CommandResult<review::CommitOutcome> {
    let (_, root) = git_workspace(&state, &request.workspace_id)?;
    review::commit(&root, &request.message)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    pub workspace_id: String,
    pub remote: String,
}

/// Publication is explicit (REV-05): the renderer confirms repository, remote
/// and branch before calling this.
#[tauri::command]
pub async fn git_push(request: PushRequest, state: State<'_, AppState>) -> CommandResult<String> {
    let (_, root) = git_workspace(&state, &request.workspace_id)?;
    let remote = request.remote.clone();
    tauri::async_runtime::spawn_blocking(move || review::push(&root, &remote))
        .await
        .map_err(|e| DesktopError::io(e.to_string()))?
}

/// The content pair behind one change so the renderer can show a side-by-side
/// diff: baseline versus working tree, index versus working tree, or HEAD
/// versus index.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionsRequest {
    pub workspace_id: String,
    pub scope: String,
    pub path: String,
    #[serde(default)]
    pub before_hash: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersions {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
    pub before_label: String,
    pub after_label: String,
    pub after_hash: Option<String>,
}

#[tauri::command]
pub fn review_file_versions(request: VersionsRequest, state: State<'_, AppState>) -> CommandResult<FileVersions> {
    let record = workspace(&state, &request.workspace_id)?;
    let root = PathBuf::from(&record.canonical_root);
    resolve_contained(&root, &request.path)?;
    let current = read_text(&root, &request.path, 0, 200_000).ok();
    let (after, after_hash) = match &current {
        Some(read) if !read.binary && !read.truncated => (Some(read.content.clone()), Some(read.content_hash.clone())),
        _ => (None, current.as_ref().map(|r| r.content_hash.clone())),
    };
    match request.scope.as_str() {
        "baseline" | "session_baseline" => {
            let blobs = BlobStore::new(state.data_dir.join("blobs"));
            let before = match &request.before_hash {
                Some(hash) => blobs.get(hash)?.map(|bytes| String::from_utf8_lossy(&bytes).into_owned()),
                None => None,
            };
            Ok(FileVersions { path: request.path, before, after, before_label: "baseline".into(), after_label: "working tree".into(), after_hash })
        }
        "working_tree" => {
            let before = review::show_file(&root, ":0", &request.path)?;
            Ok(FileVersions { path: request.path, before, after, before_label: "index".into(), after_label: "working tree".into(), after_hash })
        }
        "staged" => {
            let before = review::show_file(&root, "HEAD", &request.path)?;
            let index = review::show_file(&root, ":0", &request.path)?;
            Ok(FileVersions { path: request.path, before, after: index, before_label: "HEAD".into(), after_label: "index".into(), after_hash: None })
        }
        other => Err(DesktopError::io(format!("unknown scope {other}"))),
    }
}

// --- Worktrees ---------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeView {
    pub git: Vec<WorktreeEntry>,
    pub managed: Vec<WorktreeRecord>,
    pub managed_root: String,
}

fn managed_root(state: &AppState, record: &WorkspaceRecord) -> PathBuf {
    state.data_dir.join("worktrees").join(&record.workspace_hash)
}

#[tauri::command]
pub fn worktree_list(workspace_id: String, state: State<'_, AppState>) -> CommandResult<WorktreeView> {
    let record = workspace(&state, &workspace_id)?;
    let root = PathBuf::from(&record.canonical_root);
    let git = if review::is_git_repository(&root) { review::worktree_list(&root)? } else { Vec::new() };
    let managed = state.with_storage(|s| s.worktree_list(&record.id)).map_err(storage_error)?;
    Ok(WorktreeView { git, managed, managed_root: managed_root(&state, &record).to_string_lossy().into_owned() })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreateRequest {
    pub workspace_id: String,
    pub branch: String,
    pub base_ref: String,
    /// Explicit decision about uncommitted changes in the source checkout:
    /// copy them (tracked patch plus untracked files) or start clean.
    pub carry_uncommitted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreated {
    pub record: WorktreeRecord,
    pub workspace: WorkspaceRecord,
    pub carried_patch_bytes: usize,
    pub carried_untracked: usize,
}

#[tauri::command]
pub fn worktree_create(request: WorktreeCreateRequest, state: State<'_, AppState>) -> CommandResult<WorktreeCreated> {
    let (record, root) = git_workspace(&state, &request.workspace_id)?;
    let slug: String = request
        .branch
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .collect();
    let path = managed_root(&state, &record).join(slug);
    let (patch, untracked) = if request.carry_uncommitted { review::uncommitted_snapshot(&root)? } else { (String::new(), Vec::new()) };
    review::worktree_add(&root, &path, &request.branch, &request.base_ref)?;
    if request.carry_uncommitted {
        review::transfer_uncommitted(&root, &path, &patch, &untracked)?;
    }
    let worktree = state
        .with_storage(|s| s.worktree_insert(&record.id, &path.to_string_lossy(), &request.branch, &request.base_ref))
        .map_err(storage_error)?;
    // The worktree is its own workspace root; it inherits nothing implicitly,
    // so the user reviews and trusts it like any other folder.
    let identity = WorkspaceIdentity::resolve(&path)?;
    let workspace = state
        .with_storage(|s| s.workspace_upsert(&identity.canonical_root.to_string_lossy(), &identity.display_path, &identity.workspace_hash))
        .map_err(storage_error)?;
    Ok(WorktreeCreated { record: worktree, workspace, carried_patch_bytes: patch.len(), carried_untracked: untracked.len() })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoveRequest {
    pub workspace_id: String,
    pub worktree_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemovePreview {
    pub path: String,
    pub branch: String,
    pub live_sessions: Vec<String>,
    pub dirty_files: Vec<String>,
    pub untracked_files: Vec<String>,
    pub pinned: bool,
}

/// What removal would do, so the renderer can show it before confirming.
#[tauri::command]
pub fn worktree_remove_preview(request: WorktreeRemoveRequest, state: State<'_, AppState>) -> CommandResult<WorktreeRemovePreview> {
    let record = workspace(&state, &request.workspace_id)?;
    let worktrees = state.with_storage(|s| s.worktree_list(&record.id)).map_err(storage_error)?;
    let worktree = worktrees.into_iter().find(|w| w.id == request.worktree_id).ok_or_else(|| DesktopError::not_ready("worktree not found"))?;
    let path = PathBuf::from(&worktree.path);
    let live = state.actors_under(&path);
    let (dirty, untracked) = if path.exists() {
        let status = review::git_status(&path)?;
        (
            status.iter().filter(|e| !e.untracked).map(|e| e.path.clone()).collect(),
            status.iter().filter(|e| e.untracked).map(|e| e.path.clone()).collect(),
        )
    } else {
        (Vec::new(), Vec::new())
    };
    Ok(WorktreeRemovePreview { path: worktree.path, branch: worktree.branch, live_sessions: live, dirty_files: dirty, untracked_files: untracked, pinned: worktree.pinned })
}

/// Removes a managed worktree after snapshotting its dirty and untracked files
/// into the blob store (recorded as a `worktree_cleanup` baseline). Refuses
/// while sessions are attached to it or when pinned.
#[tauri::command]
pub fn worktree_remove(request: WorktreeRemoveRequest, state: State<'_, AppState>) -> CommandResult<Option<String>> {
    let (record, root) = git_workspace(&state, &request.workspace_id)?;
    let worktrees = state.with_storage(|s| s.worktree_list(&record.id)).map_err(storage_error)?;
    let worktree = worktrees.into_iter().find(|w| w.id == request.worktree_id).ok_or_else(|| DesktopError::not_ready("worktree not found"))?;
    if worktree.pinned {
        return Err(DesktopError::conflict("this worktree is pinned; unpin it first"));
    }
    let path = PathBuf::from(&worktree.path);
    let live = state.actors_under(&path);
    if !live.is_empty() {
        return Err(DesktopError::conflict(format!("{} live session(s) still use this worktree; stop them first", live.len())));
    }
    let mut snapshot_id = None;
    if path.exists() {
        let blobs = BlobStore::new(state.data_dir.join("blobs"));
        let manifest = capture_baseline(&path, &blobs)?;
        let saved = state
            .with_storage(|s| s.baseline_insert(&record.id, None, "worktree_cleanup", Some(&worktree.branch), &manifest))
            .map_err(storage_error)?;
        snapshot_id = Some(saved.id);
        review::worktree_remove(&root, &path, true)?;
    }
    state.with_storage(|s| s.worktree_mark_removed(&worktree.id)).map_err(storage_error)?;
    Ok(snapshot_id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinRequest {
    pub worktree_id: String,
    pub pinned: bool,
}

#[tauri::command]
pub fn worktree_pin(request: PinRequest, state: State<'_, AppState>) -> CommandResult<()> {
    state.with_storage(|s| s.worktree_set_pinned(&request.worktree_id, request.pinned)).map_err(storage_error)
}

// --- External editors (EDT-01) -----------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EditorProfile {
    Vscode,
    Rider,
    Cursor,
    System,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInEditorRequest {
    pub workspace_id: String,
    pub relative: String,
    pub editor: EditorProfile,
    #[serde(default)]
    pub line: Option<u32>,
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var).map(|dir| dir.join(name)).find(|candidate| candidate.is_file())
}

/// Opens a workspace file in an allowlisted editor with validated arguments.
#[tauri::command]
pub fn open_in_editor(request: OpenInEditorRequest, state: State<'_, AppState>) -> CommandResult<()> {
    let record = workspace(&state, &request.workspace_id)?;
    let root = Path::new(&record.canonical_root);
    let target = resolve_contained(root, &request.relative)?;
    let line = request.line.unwrap_or(1).max(1);
    let (program, args): (PathBuf, Vec<String>) = match request.editor {
        EditorProfile::Vscode => (
            find_on_path("code").ok_or_else(|| DesktopError::unsupported("VS Code's `code` command is not on PATH"))?,
            vec!["--goto".into(), format!("{}:{line}", target.display())],
        ),
        EditorProfile::Cursor => (
            find_on_path("cursor").ok_or_else(|| DesktopError::unsupported("Cursor's `cursor` command is not on PATH"))?,
            vec!["--goto".into(), format!("{}:{line}", target.display())],
        ),
        EditorProfile::Rider => (
            find_on_path("rider").ok_or_else(|| DesktopError::unsupported("JetBrains Rider's `rider` command is not on PATH"))?,
            vec!["--line".into(), line.to_string(), target.display().to_string()],
        ),
        EditorProfile::System => {
            if cfg!(target_os = "macos") {
                (PathBuf::from("/usr/bin/open"), vec![target.display().to_string()])
            } else if cfg!(target_os = "windows") {
                (PathBuf::from("explorer"), vec![target.display().to_string()])
            } else {
                (find_on_path("xdg-open").ok_or_else(|| DesktopError::unsupported("xdg-open not found"))?, vec![target.display().to_string()])
            }
        }
    };
    std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| DesktopError::io(format!("could not launch editor: {e}")))
}
