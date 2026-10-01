//! Workspace inspection and trust (UX-02, ARCH-06, FS-01).
//!
//! Inspection never starts an agent, MCP servers, hooks or previews. It shows the
//! executable configuration sources a trust decision covers and fingerprints
//! them so a later change forces re-review before the next launch.

use std::{fs, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use thingmaker_supervisor::{
    DesktopError,
    storage::workspaces::{TrustState, WorkspaceRecord},
    workspace::WorkspaceIdentity,
};

use super::{CommandResult, storage_error};
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSource {
    pub path: String,
    pub kind: &'static str,
    pub present: bool,
    pub bytes: u64,
    /// Human-readable summary (server names, commands); never secrets.
    pub summary: Vec<String>,
    pub executable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInspection {
    pub identity: WorkspaceIdentity,
    pub record: WorkspaceRecord,
    pub sources: Vec<ConfigSource>,
    /// Fingerprint of the executable configuration sources listed above.
    pub trust_digest: String,
    /// True when the stored trust decision covered a different configuration.
    pub trust_stale: bool,
    pub is_git_repository: bool,
    pub is_unity_project: bool,
}

fn summarize_mcp(path: &Path) -> (Vec<String>, bool) {
    let Ok(text) = fs::read_to_string(path) else {
        return (vec!["unreadable".into()], false);
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return (vec!["invalid JSON".into()], false);
    };
    let servers = value
        .get("mcpServers")
        .and_then(Value::as_object)
        .map(|servers| {
            servers
                .iter()
                .map(|(name, server)| {
                    let command = server.get("command").and_then(Value::as_str).unwrap_or("");
                    let url = server.get("url").and_then(Value::as_str).unwrap_or("");
                    let transport = server.get("type").or_else(|| server.get("transport")).and_then(Value::as_str).unwrap_or("");
                    match (command.is_empty(), url.is_empty()) {
                        (false, _) => format!("{name}: runs `{command}`"),
                        (true, false) => format!("{name}: connects to {url} {transport}"),
                        _ => format!("{name}: {transport}"),
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let executable = !servers.is_empty();
    (servers, executable)
}

fn inspect_sources(root: &Path) -> (Vec<ConfigSource>, String) {
    let mut hasher = blake3::Hasher::new();
    let mut sources = Vec::new();
    // What an agent executes or obeys when it starts in this root: MCP
    // servers (Claude Code's `.mcp.json`, Codex's project config), hooks
    // (Claude Code's project settings) and instruction files.
    let candidates: [(&str, &'static str, bool); 6] = [
        (".mcp.json", "mcp", true),
        (".claude/settings.json", "claude-settings", true),
        (".claude/settings.local.json", "claude-settings", true),
        (".codex/config.toml", "codex-config", true),
        ("AGENTS.md", "instructions", false),
        ("CLAUDE.md", "instructions", false),
    ];
    for (relative, kind, executable_kind) in candidates {
        let path = root.join(relative);
        let metadata = fs::metadata(&path).ok();
        let present = metadata.as_ref().is_some_and(|m| m.is_file());
        let bytes = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        let (summary, executable) = if present && kind == "mcp" {
            summarize_mcp(&path)
        } else if present {
            (Vec::new(), executable_kind)
        } else {
            (Vec::new(), false)
        };
        if present {
            hasher.update(relative.as_bytes());
            if let Ok(content) = fs::read(&path) {
                hasher.update(&content);
            }
        }
        sources.push(ConfigSource {
            path: relative.to_string(),
            kind,
            present,
            bytes,
            summary,
            executable,
        });
    }
    (sources, hasher.finalize().to_hex().to_string())
}

/// Every workspace added to ThingMaker is trusted for local execution: it is a
/// folder of the user's own, and agents run there with the user's authority.
/// Recorded with the current configuration's fingerprint, so a change to
/// `.mcp.json` or the settings never leaves it "stale" and unopenable.
pub fn ensure_trusted(state: &AppState, record: WorkspaceRecord) -> CommandResult<WorkspaceRecord> {
    let (_, digest) = inspect_sources(Path::new(&record.canonical_root));
    if record.trust_state == TrustState::TrustedLocal && record.trust_digest.as_deref() == Some(digest.as_str()) {
        return Ok(record);
    }
    state
        .with_storage(|storage| storage.workspace_set_trust(&record.id, TrustState::TrustedLocal, Some(&digest)))
        .map_err(storage_error)
}

fn build_inspection(state: &AppState, record: WorkspaceRecord) -> CommandResult<WorkspaceInspection> {
    let record = ensure_trusted(state, record)?;
    let root = Path::new(&record.canonical_root);
    let identity = WorkspaceIdentity::resolve(root)?;
    let (sources, trust_digest) = inspect_sources(&identity.canonical_root);
    let trust_stale = record.trust_state != TrustState::Untrusted
        && record.trust_digest.as_deref() != Some(trust_digest.as_str());
    let _ = state;
    Ok(WorkspaceInspection {
        is_git_repository: identity.canonical_root.join(".git").exists(),
        is_unity_project: identity.canonical_root.join("ProjectSettings").join("ProjectVersion.txt").is_file()
            && identity.canonical_root.join("Assets").is_dir(),
        identity,
        record,
        sources,
        trust_digest,
        trust_stale,
    })
}

#[tauri::command]
pub fn workspace_inspect(path: String, state: State<'_, AppState>) -> CommandResult<WorkspaceInspection> {
    if path.trim().is_empty() {
        return Err(DesktopError::io("workspace path is empty"));
    }
    let identity = WorkspaceIdentity::resolve(Path::new(&path))?;
    let record = state
        .with_storage(|storage| {
            storage.workspace_upsert(
                &identity.canonical_root.to_string_lossy(),
                &identity.display_path,
                &identity.workspace_hash,
            )
        })
        .map_err(storage_error)?;
    build_inspection(&state, record)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustRequest {
    pub workspace_id: String,
    pub state: TrustState,
    /// Must equal the digest shown during inspection; a mismatch means the
    /// configuration changed under the user and must be reviewed again.
    pub trust_digest: String,
}

#[tauri::command]
pub fn workspace_trust(request: TrustRequest, state: State<'_, AppState>) -> CommandResult<WorkspaceInspection> {
    let record = state
        .with_storage(|storage| storage.workspace_get(&request.workspace_id))
        .map_err(storage_error)?
        .ok_or_else(|| DesktopError::not_ready("workspace not found"))?;
    let (_, current_digest) = inspect_sources(Path::new(&record.canonical_root));
    if request.state != TrustState::Untrusted && current_digest != request.trust_digest {
        return Err(DesktopError::conflict(
            "The workspace's executable configuration changed since you reviewed it. Inspect it again before trusting.",
        ));
    }
    let record = state
        .with_storage(|storage| {
            storage.workspace_set_trust(
                &request.workspace_id,
                request.state,
                if request.state == TrustState::Untrusted { None } else { Some(&current_digest) },
            )
        })
        .map_err(storage_error)?;
    build_inspection(&state, record)
}

#[tauri::command]
pub fn workspace_list(state: State<'_, AppState>) -> CommandResult<Vec<WorkspaceRecord>> {
    state.with_storage(|storage| storage.workspace_list()).map_err(storage_error)
}

/// Native folder picker. Returns `None` when the user cancels. Picking does not
/// inspect or trust anything; the renderer follows up with `workspace_inspect`.
#[tauri::command]
pub async fn workspace_pick(app: tauri::AppHandle) -> CommandResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Choose a workspace root")
            .blocking_pick_folder()
    })
    .await
    .map_err(|error| DesktopError::io(format!("folder picker failed: {error}")))?;
    Ok(picked.map(|path| path.to_string()))
}


/// Forgets a workspace in the desktop (records, baselines, archive flags).
/// Refused while any session of that workspace is attached; files on disk
/// and the agents' transcripts are never touched.
#[tauri::command]
pub fn workspace_remove(workspace_id: String, state: State<'_, AppState>) -> CommandResult<()> {
    let record = state
        .with_storage(|s| s.workspace_get(&workspace_id))
        .map_err(storage_error)?
        .ok_or_else(|| DesktopError::not_ready("workspace not found"))?;
    let live = state.actors_under(std::path::Path::new(&record.canonical_root));
    if !live.is_empty() {
        return Err(DesktopError::conflict(format!(
            "{} live session(s) still use this workspace; stop them first",
            live.len()
        )));
    }
    state.with_storage(|s| s.workspace_delete(&workspace_id)).map_err(storage_error)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub profile: thingmaker_supervisor::security::ExecutionProfile,
    pub label: &'static str,
    pub explanation: &'static str,
    pub available: bool,
}

/// The execution profiles a workspace can be trusted under, with what each
/// one lets an agent do (UX-01).
#[tauri::command]
pub fn execution_profiles() -> Vec<ProfileInfo> {
    use thingmaker_supervisor::security::ExecutionProfile;
    [
        ExecutionProfile::InspectOnly,
        ExecutionProfile::TrustedLocal,
        ExecutionProfile::RestrictedEnvironment,
        ExecutionProfile::RemoteManaged,
    ]
    .into_iter()
    .map(|profile| ProfileInfo {
        profile,
        label: profile.label(),
        explanation: profile.explanation(),
        available: profile.available_in_r1(),
    })
    .collect()
}

/// Opens a workspace (or a folder inside one) in Finder. Only paths inside a
/// workspace Code knows are opened; anything else is refused.
#[tauri::command]
pub fn reveal_in_finder(path: String, state: State<'_, AppState>) -> CommandResult<()> {
    let resolved = std::fs::canonicalize(&path).map_err(|error| DesktopError::io(format!("{path}: {error}")))?;
    let known = state
        .with_storage(|storage| storage.workspace_list())
        .map_err(storage_error)?
        .iter()
        .any(|workspace| resolved.starts_with(&workspace.canonical_root));
    if !known {
        return Err(DesktopError::untrusted("only folders inside a workspace are opened"));
    }
    let mut command = std::process::Command::new("open");
    // A folder opens; a file is shown selected in its folder.
    if resolved.is_dir() {
        command.arg(&resolved);
    } else {
        command.arg("-R").arg(&resolved);
    }
    command.spawn().map(|_| ()).map_err(|error| DesktopError::io(format!("could not open Finder: {error}")))
}
