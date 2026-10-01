//! Support bundles, storage inspector and retention cleanup (REL-05, REL-06,
//! section 15.2).
//!
//! Everything is generated locally and previewed before export. No upload, no
//! automatic issue filing. Cleanup deletes only what a preview listed and
//! never touches an agent's canonical history.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;
use thingmaker_supervisor::{DesktopError, storage::now_unix_ms};

use super::{CommandResult, skills::dir_size, storage_error};
use crate::state::AppState;

pub const LOG_RETENTION_DAYS: u64 = 7;
pub const CACHE_RETENTION_DAYS: u64 = 30;

fn redact_home(text: &str, home: Option<&Path>) -> String {
    match home {
        Some(home) => text.replace(&home.to_string_lossy().into_owned(), "~"),
        None => text.to_string(),
    }
}

/// Recent warning/error lines from the desktop log, with the home directory
/// collapsed. The agents' own output is not part of this log.
fn recent_log_lines(data_dir: &Path, home: Option<&Path>, limit: usize) -> Vec<String> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(data_dir.join("logs"))
        .map(|entries| entries.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect())
        .unwrap_or_default();
    files.sort();
    let mut lines = Vec::new();
    for file in files.iter().rev().take(2) {
        if let Ok(text) = std::fs::read_to_string(file) {
            for line in text.lines().rev() {
                if line.contains("WARN") || line.contains("ERROR") {
                    lines.push(redact_home(line, home));
                    if lines.len() >= limit {
                        break;
                    }
                }
            }
        }
        if lines.len() >= limit {
            break;
        }
    }
    lines.reverse();
    lines
}

/// Builds the bundle as JSON for the renderer to preview and redact before
/// saving. Contents: versions, anonymized state, recent safe errors, settings.
/// Excluded by design: prompts, transcripts, environment variables, tokens.
#[tauri::command]
pub async fn support_bundle_preview(app: tauri::AppHandle, state: State<'_, AppState>) -> CommandResult<Value> {
    let package = app.package_info();
    let mut sessions = Vec::new();
    for (id, _root) in state.actor_entries() {
        if let Some(actor) = state.actor(&id)
            && let Ok(snapshot) = actor.snapshot().await
        {
            sessions.push(json!({
                "id": format!("{}…", &id[..id.len().min(8)]),
                "process": snapshot.process,
                "attachment": snapshot.attachment,
                "foreground": snapshot.foreground,
                "events": snapshot.last_sequence,
                "historyDropped": snapshot.history_dropped,
            }));
        }
    }
    let workspaces = state.with_storage(|s| s.workspace_list()).map_err(storage_error)?;
    let mut uncertain = 0;
    for workspace in &workspaces {
        uncertain += state.with_storage(|s| s.outbox_uncertain_for_workspace(&workspace.id)).map(|v| v.len()).unwrap_or(0);
    }
    let schema_version = state.with_storage(|s| s.schema_version()).map_err(storage_error)?;
    let settings: Option<Value> = state.with_storage(|s| s.setting_get("notifications", "global")).ok().flatten();
    // Where each provider's program was found and how, never who is signed
    // in: an account name is personal data and does not help a bug report.
    let providers: Vec<Value> = thingmaker_supervisor::agents::Provider::ALL
        .iter()
        .map(|provider| match state.resolve_provider(*provider) {
            Ok(resolved) => json!({ "provider": provider.as_str(), "found": true, "source": resolved.source }),
            Err(_) => json!({ "provider": provider.as_str(), "found": false }),
        })
        .collect();
    Ok(json!({
        "generatedAt": now_unix_ms(),
        "app": {
            "name": package.name,
            "version": package.version.to_string(),
            "tauri": tauri::VERSION,
            "webview": tauri::webview_version().ok(),
            "desktopApiVersion": thingmaker_supervisor::DESKTOP_API_VERSION,
            "schemaVersion": schema_version,
        },
        "providers": providers,
        "os": { "family": std::env::consts::OS, "arch": std::env::consts::ARCH },
        "state": {
            "workspaces": workspaces.len(),
            "liveSessions": sessions,
            "terminals": state.terminals.list().len(),
            "uncertainSubmissions": uncertain,
        },
        "recentErrors": recent_log_lines(&state.data_dir, state.home.as_deref(), 200),
        "settings": settings,
        "excluded": ["prompts and transcripts", "environment variables", "credentials and tokens", "workspace paths beyond ~ collapsing", "the agents' own logs", "signed-in account names"],
    }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageEntry {
    pub name: &'static str,
    pub path: String,
    pub bytes: u64,
    pub policy: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageReport {
    pub data_dir: String,
    pub entries: Vec<StorageEntry>,
    pub attachments: usize,
    pub artifact_versions: usize,
    pub notes: Vec<&'static str>,
}

#[tauri::command]
pub fn storage_inspect(state: State<'_, AppState>) -> CommandResult<StorageReport> {
    let d = &state.data_dir;
    let size = |p: PathBuf| if p.is_dir() { dir_size(&p) } else { std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0) };
    let entries = vec![
        StorageEntry { name: "metadata database", path: d.join("thingmaker.db").to_string_lossy().into_owned(), bytes: size(d.join("thingmaker.db")) + size(d.join("thingmaker.db-wal")), policy: "kept; backed up before migrations" },
        StorageEntry { name: "database backups", path: d.to_string_lossy().into_owned(), bytes: std::fs::read_dir(d).map(|e| e.flatten().filter(|e| e.file_name().to_string_lossy().contains(".bak.db")).map(|e| e.metadata().map(|m| m.len()).unwrap_or(0)).sum()).unwrap_or(0), policy: "cleanup candidate after 30 days" },
        StorageEntry { name: "submission payloads", path: d.join("outbox").to_string_lossy().into_owned(), bytes: size(d.join("outbox")), policy: "kept while the submission is queued or uncertain" },
        StorageEntry { name: "attachments", path: d.join("attachments").to_string_lossy().into_owned(), bytes: size(d.join("attachments")), policy: "kept while referenced by a draft; cleanup candidate after 30 days otherwise" },
        StorageEntry { name: "review baselines", path: d.join("blobs").to_string_lossy().into_owned(), bytes: size(d.join("blobs")), policy: "derived cache; kept while a baseline references it" },
        StorageEntry { name: "artifact versions", path: d.join("artifacts").to_string_lossy().into_owned(), bytes: size(d.join("artifacts")), policy: "kept; user-visible history is never auto-deleted" },
        StorageEntry { name: "desktop logs", path: d.join("logs").to_string_lossy().into_owned(), bytes: size(d.join("logs")), policy: "7 days" },
        StorageEntry { name: "skill backups", path: d.join("skill-backups").to_string_lossy().into_owned(), bytes: size(d.join("skill-backups")), policy: "replaced or removed skills; delete by hand when no longer needed" },
        StorageEntry { name: "managed worktrees", path: d.join("worktrees").to_string_lossy().into_owned(), bytes: size(d.join("worktrees")), policy: "removed only through the worktree preview flow" },
    ];
    let attachments = state.with_storage(|s| s.attachment_list()).map(|v| v.len()).unwrap_or(0);
    let artifact_versions = state.with_storage(|s| s.artifact_hashes_in_use()).map(|v| v.len()).unwrap_or(0);
    Ok(StorageReport {
        data_dir: d.to_string_lossy().into_owned(),
        entries,
        attachments,
        artifact_versions,
        notes: vec![
            "The agents' own transcripts (~/.claude/projects, ~/.codex/sessions) are canonical and are never deleted by the desktop.",
            "Nothing here is encrypted by the application; rely on account permissions and full-disk encryption.",
        ],
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCandidate {
    pub kind: &'static str,
    pub path: String,
    pub bytes: u64,
    pub reason: String,
}

fn older_than(path: &Path, days: u64) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age.as_secs() > days * 86_400)
}

fn compute_candidates(state: &AppState) -> CommandResult<Vec<CleanupCandidate>> {
    let d = &state.data_dir;
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(d.join("logs")) {
        for entry in entries.flatten() {
            if older_than(&entry.path(), LOG_RETENTION_DAYS) {
                out.push(CleanupCandidate { kind: "log_file", path: entry.path().to_string_lossy().into_owned(), bytes: entry.metadata().map(|m| m.len()).unwrap_or(0), reason: format!("older than {LOG_RETENTION_DAYS} days") });
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(d) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.contains(".bak.db") && older_than(&entry.path(), CACHE_RETENTION_DAYS) {
                out.push(CleanupCandidate { kind: "database_backup", path: entry.path().to_string_lossy().into_owned(), bytes: entry.metadata().map(|m| m.len()).unwrap_or(0), reason: format!("pre-migration backup older than {CACHE_RETENTION_DAYS} days") });
            }
        }
    }
    let referenced = state.with_storage(|s| s.attachment_referenced_ids()).map_err(storage_error)?;
    let attachments = state.with_storage(|s| s.attachment_list()).map_err(storage_error)?;
    let now = now_unix_ms();
    for attachment in attachments {
        let age_days = (now - attachment.created_at).max(0) as u64 / 86_400_000;
        if !referenced.contains(&attachment.id) && attachment.retention_state != "pinned" && age_days > CACHE_RETENTION_DAYS {
            out.push(CleanupCandidate { kind: "attachment", path: d.join("attachments").join(&attachment.id).to_string_lossy().into_owned(), bytes: attachment.bytes.max(0) as u64, reason: format!("not referenced by any draft and older than {CACHE_RETENTION_DAYS} days") });
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn cleanup_preview(state: State<'_, AppState>) -> CommandResult<Vec<CleanupCandidate>> {
    compute_candidates(&state)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupRunRequest {
    pub paths: Vec<String>,
}

/// Deletes only paths that are both requested and currently listed as
/// candidates, and only inside the app data directory.
#[tauri::command]
pub fn cleanup_run(request: CleanupRunRequest, state: State<'_, AppState>) -> CommandResult<Vec<CleanupCandidate>> {
    let candidates = compute_candidates(&state)?;
    let data_dir = std::fs::canonicalize(&state.data_dir).map_err(|e| DesktopError::io(e.to_string()))?;
    let mut removed = Vec::new();
    for candidate in candidates {
        if !request.paths.contains(&candidate.path) {
            continue;
        }
        let path = PathBuf::from(&candidate.path);
        let canonical = std::fs::canonicalize(&path).map_err(|e| DesktopError::io(e.to_string()))?;
        if !canonical.starts_with(&data_dir) {
            return Err(DesktopError::io("refusing to delete outside the app data directory"));
        }
        std::fs::remove_file(&canonical).map_err(|e| DesktopError::io(e.to_string()))?;
        if candidate.kind == "attachment"
            && let Some(id) = path.file_name().map(|n| n.to_string_lossy().into_owned())
        {
            let _ = state.with_storage(|s| s.attachment_delete(&id));
        }
        removed.push(candidate);
    }
    Ok(removed)
}

/// Deletes desktop log files past retention at startup (never an agent's files).
pub fn prune_logs(data_dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(data_dir.join("logs")) {
        for entry in entries.flatten() {
            if older_than(&entry.path(), LOG_RETENTION_DAYS) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}
