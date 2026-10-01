//! Desktop preferences, tray/close behaviour and confirmations (UX-10, ARCH-02).
//!
//! Closing the last window never silently kills local work: the stored close
//! behaviour is `ask` by default and the choices are explicit ("keep running
//! in tray" or "quit and stop local tasks"). Quitting stops every attached Kit
//! helper through the actors' bounded shutdown before the process exits.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use thingmaker_supervisor::{DesktopError, storage::settings::GLOBAL_SCOPE};

use super::{CommandResult, storage_error};
use crate::state::AppState;

pub const SETTINGS_KEY: &str = "notifications";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CloseBehavior {
    #[default]
    Ask,
    Tray,
    Quit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationSettings {
    pub enabled: bool,
    pub notify_completed: bool,
    pub notify_failed: bool,
    pub notify_needs_input: bool,
    pub quiet_hours_start: String,
    pub quiet_hours_end: String,
    pub muted_workspace_ids: Vec<String>,
    pub close_behavior: CloseBehavior,
    /// Odyssey defaults for a new goal (docs/plans/odyssey.md §7). Held low
    /// until a full run has been watched; a goal keeps whatever ceiling it was
    /// created with, so raising this never loosens a running goal.
    pub odyssey_max_continuations: i64,
    pub odyssey_token_budget: Option<i64>,
    /// What a Claude session runs on when nothing else is asked for, by the
    /// adapter's own ids. Read by `session_open`; `None` is the built-in
    /// preference. Missing from this struct, a choice in Settings was
    /// dropped on save and the picker snapped back.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_orchestrator_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_orchestrator_effort: Option<String>,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            notify_completed: true,
            notify_failed: true,
            notify_needs_input: true,
            quiet_hours_start: "00:00".into(),
            quiet_hours_end: "00:00".into(),
            muted_workspace_ids: Vec::new(),
            close_behavior: CloseBehavior::Ask,
            odyssey_max_continuations: 10,
            odyssey_token_budget: None,
            claude_orchestrator_model: None,
            claude_orchestrator_effort: None,
        }
    }
}

fn valid_clock(value: &str) -> bool {
    let mut parts = value.split(':');
    let (Some(h), Some(m), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    matches!((h.parse::<u8>(), m.parse::<u8>()), (Ok(h), Ok(m)) if h < 24 && m < 60)
}

pub fn load_settings(state: &AppState) -> NotificationSettings {
    state
        .with_storage(|storage| storage.setting_get::<NotificationSettings>(SETTINGS_KEY, GLOBAL_SCOPE))
        .ok()
        .flatten()
        .unwrap_or_default()
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> CommandResult<NotificationSettings> {
    Ok(load_settings(&state))
}

#[tauri::command]
pub fn settings_set(settings: NotificationSettings, state: State<'_, AppState>) -> CommandResult<NotificationSettings> {
    if !valid_clock(&settings.quiet_hours_start) || !valid_clock(&settings.quiet_hours_end) {
        return Err(DesktopError::io("quiet hours must be HH:MM (24-hour)"));
    }
    if settings.muted_workspace_ids.len() > 1000 || settings.muted_workspace_ids.iter().any(|id| id.len() > 128) {
        return Err(DesktopError::io("invalid muted workspace list"));
    }
    // A goal that could not continue at all, or a nonsense budget, would be a
    // setting that quietly breaks the runner.
    if settings.odyssey_max_continuations < 1 || settings.odyssey_max_continuations > 10_000 {
        return Err(DesktopError::io("the Odyssey continuation limit must be between 1 and 10000"));
    }
    if settings.odyssey_token_budget.is_some_and(|budget| budget < 1) {
        return Err(DesktopError::io("an Odyssey token budget must be positive, or unset"));
    }
    if [&settings.claude_orchestrator_model, &settings.claude_orchestrator_effort].iter().any(|value| value.as_ref().is_some_and(|text| text.len() > 128)) {
        return Err(DesktopError::io("the Claude model or effort is not a valid id"));
    }
    state
        .with_storage(|storage| storage.setting_set(SETTINGS_KEY, GLOBAL_SCOPE, &settings))
        .map_err(storage_error)?;
    Ok(settings)
}

/// Hides the main window; session actors keep running (ARCH-02).
#[tauri::command]
pub fn app_hide_to_tray(app: AppHandle) -> CommandResult<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|error| DesktopError::io(error.to_string()))?;
    }
    Ok(())
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Stops every attached helper within a bounded budget, then exits.
pub async fn quit_and_stop(app: AppHandle, stop_sessions: bool) {
    if stop_sessions
        && let Some(state) = app.try_state::<AppState>()
    {
        state.terminals.close_all();
        let ids = state.actor_ids();
        let actors: Vec<_> = ids.iter().filter_map(|id| state.remove_actor(id)).collect();
        let stops = actors.iter().map(|actor| actor.stop());
        let _ = tokio::time::timeout(Duration::from_secs(12), futures_join_all(stops)).await;
    }
    app.exit(0);
}

async fn futures_join_all<F: std::future::Future>(futures: impl IntoIterator<Item = F>) -> Vec<F::Output> {
    let mut handles = Vec::new();
    for future in futures {
        handles.push(Box::pin(future));
    }
    let mut outputs = Vec::new();
    for handle in handles {
        outputs.push(handle.await);
    }
    outputs
}

#[tauri::command]
pub async fn app_quit(stop_sessions: bool, app: AppHandle) -> CommandResult<()> {
    tauri::async_runtime::spawn(quit_and_stop(app, stop_sessions));
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmRequest {
    pub title: String,
    pub message: String,
    pub ok_label: String,
    pub cancel_label: String,
    #[serde(default)]
    pub warning: bool,
}

/// Native confirmation dialog for mediated actions (SEC-06). Returns true when
/// the user picked the confirming button.
#[tauri::command]
pub async fn confirm_dialog(request: ConfirmRequest, app: AppHandle) -> CommandResult<bool> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    if request.title.len() > 200 || request.message.len() > 2000 {
        return Err(DesktopError::io("dialog text too long"));
    }
    let confirmed = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(request.message)
            .title(request.title)
            .kind(if request.warning { MessageDialogKind::Warning } else { MessageDialogKind::Info })
            .buttons(MessageDialogButtons::OkCancelCustom(request.ok_label, request.cancel_label))
            .blocking_show()
    })
    .await
    .map_err(|error| DesktopError::io(format!("dialog failed: {error}")))?;
    Ok(confirmed)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivity {
    pub id: String,
    pub active: bool,
    pub detached_calls: usize,
}

/// Summarizes live helpers for the close dialog.
#[tauri::command]
pub async fn app_activity(state: State<'_, AppState>) -> CommandResult<Vec<SessionActivity>> {
    let mut activity = Vec::new();
    for id in state.actor_ids() {
        if let Some(actor) = state.actor(&id)
            && let Ok(snapshot) = actor.snapshot().await
        {
            activity.push(SessionActivity {
                active: snapshot.foreground.is_active() || !snapshot.autonomous_turns.is_empty(),
                detached_calls: snapshot
                    .detached_calls
                    .values()
                    .filter(|s| matches!(s, thingmaker_supervisor::supervisor::DetachedCallState::Active | thingmaker_supervisor::supervisor::DetachedCallState::CancellationRequested))
                    .count(),
                id,
            });
        }
    }
    Ok(activity)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clock_validation_and_defaults() {
        assert!(valid_clock("00:00") && valid_clock("23:59") && valid_clock("7:05"));
        assert!(!valid_clock("24:00") && !valid_clock("12") && !valid_clock("12:60") && !valid_clock("a:b"));
        let defaults = NotificationSettings::default();
        assert!(defaults.enabled && defaults.close_behavior == CloseBehavior::Ask);
        let parsed: NotificationSettings = serde_json::from_str("{\"enabled\": false}").unwrap();
        assert!(!parsed.enabled && parsed.notify_failed);
    }
}


/// Small, non-secret UI preferences (composer keys, context bundles, layout)
/// stored in the metadata database under the `ui` scope.
#[tauri::command]
pub fn pref_get(key: String, state: State<'_, AppState>) -> CommandResult<Option<serde_json::Value>> {
    if key.is_empty() || key.len() > 200 {
        return Err(thingmaker_supervisor::DesktopError::io("invalid preference key"));
    }
    state.with_storage(|s| s.setting_get::<serde_json::Value>(&key, "ui")).map_err(super::storage_error)
}

#[tauri::command]
pub fn pref_set(key: String, value: serde_json::Value, state: State<'_, AppState>) -> CommandResult<()> {
    if key.is_empty() || key.len() > 200 {
        return Err(thingmaker_supervisor::DesktopError::io("invalid preference key"));
    }
    if serde_json::to_vec(&value).map(|v| v.len()).unwrap_or(usize::MAX) > 256 * 1024 {
        return Err(thingmaker_supervisor::DesktopError::limit_exceeded("preference exceeds 256 KiB"));
    }
    state.with_storage(|s| s.setting_set(&key, "ui", &value)).map_err(super::storage_error)
}
