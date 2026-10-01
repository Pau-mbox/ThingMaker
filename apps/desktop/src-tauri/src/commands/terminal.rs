//! Interactive terminals (TERM-01..03).
//!
//! Creation is explicit and limited to trusted workspaces. The shell runs
//! under the same documented environment profile as Kit (ambient secrets are
//! not inherited unless allowlisted). Output is streamed as base64 chunks;
//! scrollback is replayed first so a reconnecting view is complete.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State, ipc::Channel};
use thingmaker_supervisor::{
    DesktopError,
    security::EnvironmentProfile,
    storage::workspaces::TrustState,
    terminal::{TerminalEvent, TerminalInfo, TerminalSpawn},
};

use super::{CommandResult, storage_error};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenRequest {
    pub workspace_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpened {
    pub info: TerminalInfo,
    pub workspace_id: String,
    pub environment_note: &'static str,
}

fn default_shell() -> PathBuf {
    if let Some(shell) = std::env::var_os("SHELL")
        && !shell.is_empty()
        && PathBuf::from(&shell).is_file()
    {
        return PathBuf::from(shell);
    }
    if cfg!(target_os = "macos") { PathBuf::from("/bin/zsh") } else { PathBuf::from("/bin/sh") }
}

#[tauri::command]
pub fn terminal_open(request: TerminalOpenRequest, state: State<'_, AppState>) -> CommandResult<TerminalOpened> {
    let record = state
        .with_storage(|s| s.workspace_get(&request.workspace_id))
        .map_err(storage_error)?
        .ok_or_else(|| DesktopError::not_ready("workspace not found"))?;
    if record.trust_state != TrustState::TrustedLocal {
        return Err(DesktopError::untrusted("Terminals run arbitrary commands with your account; trust the workspace (trusted local) first."));
    }
    let mut profile = EnvironmentProfile::trusted_local();
    for (name, value) in super::runtime_env::resolve_for_launch(&state).0 {
        profile = profile.with_set(name, value);
    }
    let env: Vec<(String, String)> = profile.resolve(std::env::vars()).into_iter().collect();
    let shell = default_shell();
    let terminal = state.terminals.open(TerminalSpawn {
        cwd: PathBuf::from(&record.canonical_root),
        program: shell,
        args: vec!["-l".into()],
        env,
        cols: request.cols,
        rows: request.rows,
    })?;
    state.terminal_workspaces.lock().unwrap_or_else(|p| p.into_inner()).insert(terminal.id.clone(), record.id.clone());
    Ok(TerminalOpened {
        info: terminal.info(),
        workspace_id: record.id,
        environment_note: "Shell started with the documented environment profile: PATH, locale and KIT_* variables are inherited, plus the runtime variables you added in Integrations; other ambient credentials are not.",
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalListEntry {
    pub info: TerminalInfo,
    pub workspace_id: Option<String>,
}

#[tauri::command]
pub fn terminal_list(state: State<'_, AppState>) -> Vec<TerminalListEntry> {
    let map = state.terminal_workspaces.lock().unwrap_or_else(|p| p.into_inner());
    state
        .terminals
        .list()
        .into_iter()
        .map(|info| TerminalListEntry { workspace_id: map.get(&info.id).cloned(), info })
        .collect()
}

/// Streams scrollback (as one output chunk) followed by live events.
#[tauri::command]
pub fn terminal_subscribe(id: String, on_event: Channel<TerminalEvent>, state: State<'_, AppState>) -> CommandResult<()> {
    let terminal = state.terminals.get(&id).ok_or_else(|| DesktopError::not_ready("terminal not found"))?;
    let mut receiver = terminal.subscribe();
    let scrollback = terminal.scrollback();
    if !scrollback.is_empty() {
        let _ = on_event.send(TerminalEvent::Output { data_base64: encode_base64(&scrollback) });
    }
    if terminal.is_exited() {
        let _ = on_event.send(TerminalEvent::Exit { code: terminal.info().exit_code });
        return Ok(());
    }
    tauri::async_runtime::spawn(async move {
        loop {
            match receiver.recv().await {
                Ok(event) => {
                    if on_event.send((*event).clone()).is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });
    Ok(())
}

fn encode_base64(bytes: &[u8]) -> String {
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
    out
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWriteRequest {
    pub id: String,
    /// UTF-8 text from the terminal view (keystrokes or an approved paste).
    pub text: String,
}

#[tauri::command]
pub fn terminal_write(request: TerminalWriteRequest, state: State<'_, AppState>) -> CommandResult<()> {
    let terminal = state.terminals.get(&request.id).ok_or_else(|| DesktopError::not_ready("terminal not found"))?;
    terminal.write(request.text.as_bytes())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeRequest {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
}

#[tauri::command]
pub fn terminal_resize(request: TerminalResizeRequest, state: State<'_, AppState>) -> CommandResult<()> {
    let terminal = state.terminals.get(&request.id).ok_or_else(|| DesktopError::not_ready("terminal not found"))?;
    terminal.resize(request.cols, request.rows)
}

#[tauri::command]
pub fn terminal_close(id: String, state: State<'_, AppState>) -> CommandResult<()> {
    state.terminal_workspaces.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
    state.terminals.close(&id)
}

/// Scrollback as lossy text for export. The renderer shows a redaction preview
/// before the user saves it.
#[tauri::command]
pub fn terminal_export(id: String, state: State<'_, AppState>) -> CommandResult<String> {
    let terminal = state.terminals.get(&id).ok_or_else(|| DesktopError::not_ready("terminal not found"))?;
    Ok(String::from_utf8_lossy(&terminal.scrollback()).into_owned())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTextRequest {
    pub suggested_name: String,
    pub content: String,
}

/// Saves text through the native save dialog (an explicit, mediated export).
#[tauri::command]
pub async fn save_text_file(request: SaveTextRequest, app: AppHandle) -> CommandResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    if request.content.len() > 64 * 1024 * 1024 {
        return Err(DesktopError::limit_exceeded("export exceeds 64 MiB"));
    }
    let name: String = request.suggested_name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).collect();
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_file_name(if name.is_empty() { "export.txt" } else { &name }).blocking_save_file())
        .await
        .map_err(|e| DesktopError::io(e.to_string()))?;
    let Some(path) = picked else { return Ok(None) };
    let path = path.into_path().map_err(|e| DesktopError::io(e.to_string()))?;
    std::fs::write(&path, request.content.as_bytes()).map_err(|e| DesktopError::io(e.to_string()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}
