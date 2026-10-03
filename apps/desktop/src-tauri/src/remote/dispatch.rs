//! What a paired phone may ask of ThingMaker, and nothing else.
//!
//! Each entry is one of the desktop's own commands, called with the same
//! arguments the renderer sends, so the phone's screens are the desktop's.
//! The list is deliberate: reading sessions, Big Thing and the team, and
//! controlling them — sending, steering, cancelling, starting and pausing a
//! goal, answering it, deciding its plan changes. Not on it: sign-ins and
//! provider settings, workspace trust, the terminal, git writes, file
//! writes, MCP installs, the runtime environment, deleting, and anything
//! that opens something on the Mac's screen.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use thingmaker_supervisor::DesktopError;

use crate::commands::{app as app_commands, artifacts, bigthing, delegation, git, odyssey, providers, review, session, workspace};
use crate::state::AppState;

/// The commands a phone may call. `session_subscribe` is the connection's
/// own (it streams), handled beside these.
pub const ALLOWED: &[&str] = &[
    "execution_profiles",
    "workspace_list",
    "workspace_inspect",
    "worktree_list",
    "session_list_open",
    "session_records",
    "session_snapshot",
    "session_history",
    "session_token_usage",
    "session_submit",
    "session_steer",
    "session_cancel",
    "session_set_config_option",
    "session_open",
    "session_rename",
    "session_archive",
    "session_pin",
    "session_stop",
    "outbox_list",
    "odyssey_for_session",
    "odyssey_view",
    "odyssey_list",
    "odyssey_amend_list",
    "odyssey_amend_document",
    "odyssey_plan_change_list",
    "odyssey_question_list",
    "odyssey_plan_document",
    "odyssey_workspace_notes",
    "odyssey_spend_model",
    "odyssey_create",
    "odyssey_edit_goal",
    "odyssey_set_state",
    "odyssey_add_milestone",
    "odyssey_edit_milestone",
    "odyssey_set_milestone_state",
    "odyssey_add_step",
    "odyssey_set_step_state",
    "odyssey_edit_step",
    "odyssey_question_settle",
    "odyssey_plan_change_decide",
    "odyssey_amend_add",
    "odyssey_amend_set_state",
    "odyssey_inspect_refs",
    "odyssey_read_plan",
    "odyssey_adopt_plan",
    "odyssey_journal_append",
    "bigthing_runtime",
    "bigthing_briefing",
    "bigthing_commits",
    "bigthing_start",
    "bigthing_pause",
    "bigthing_tick",
    "bigthing_request_plan",
    "bigthing_amend",
    "bigthing_decide_plan_change",
    "bigthing_answer",
    "bigthing_verify",
    "bigthing_run_check",
    "bigthing_move",
    "memory_list",
    "memory_write",
    "delegation_jobs",
    "delegation_combo_get",
    "delegation_default_combo_get",
    "delegation_quota",
    "delegation_job_cancel",
    "delegation_job_retry",
    "delegation_retry_policy_get",
    "provider_quota",
    "providers_status",
    "provider_models",
    "settings_get",
    "app_activity",
    "file_read",
    "workspace_image",
    "generated_image",
    "pref_get",
    "pref_set",
    "artifacts_list",
    "artifact_read",
    "git_info",
];

/// One argument, by the name the renderer sends it under.
fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T, DesktopError> {
    serde_json::from_value(args.get(name).cloned().unwrap_or(Value::Null)).map_err(|error| DesktopError::unsupported(format!("argument {name}: {error}")))
}

/// A command's answer, as the phone reads it.
pub trait Reply {
    fn reply(self) -> Result<Value, Value>;
}

impl<T: Serialize> Reply for Result<T, DesktopError> {
    fn reply(self) -> Result<Value, Value> {
        match self {
            Ok(value) => Ok(serde_json::to_value(value).unwrap_or(Value::Null)),
            Err(error) => Err(serde_json::to_value(error).unwrap_or(Value::Null)),
        }
    }
}

impl<T: Serialize> Reply for Vec<T> {
    fn reply(self) -> Result<Value, Value> {
        Ok(serde_json::to_value(self).unwrap_or(Value::Null))
    }
}

fn refused(error: DesktopError) -> Result<Value, Value> {
    Err(serde_json::to_value(error).unwrap_or(Value::Null))
}

macro_rules! sync_call {
    ($app:expr, $args:expr, $f:path $(, $name:literal)*) => {{
        let state = $app.state::<AppState>();
        Reply::reply($f($(match arg(&$args, $name) { Ok(value) => value, Err(error) => return refused(error) },)* state))
    }};
}

macro_rules! async_call {
    ($app:expr, $args:expr, $f:path $(, $name:literal)*) => {{
        let state = $app.state::<AppState>();
        Reply::reply($f($(match arg(&$args, $name) { Ok(value) => value, Err(error) => return refused(error) },)* state).await)
    }};
}

/// A plan document is read from a path: only from inside a workspace when a
/// phone asks.
fn inside_workspace(app: &AppHandle, args: &Value) -> Result<(), DesktopError> {
    let path: String = arg::<Value>(args, "request")?.get("path").and_then(Value::as_str).map(str::to_string).unwrap_or_default();
    let resolved = std::fs::canonicalize(&path).map_err(|error| DesktopError::io(format!("{path}: {error}")))?;
    let state = app.state::<AppState>();
    let known = state
        .with_storage(|storage| storage.workspace_list())
        .map_err(|error| DesktopError::io(error.to_string()))?
        .iter()
        .any(|workspace| resolved.starts_with(&workspace.canonical_root));
    if known { Ok(()) } else { Err(DesktopError::untrusted("from the phone, only documents inside a workspace can be read")) }
}

/// Inspecting a path records it as a workspace: from a phone, only one that
/// already is.
fn known_workspace(app: &AppHandle, args: &Value) -> Result<(), DesktopError> {
    let path: String = arg(args, "path")?;
    let resolved = std::fs::canonicalize(&path).map_err(|error| DesktopError::io(format!("{path}: {error}")))?;
    let state = app.state::<AppState>();
    let known = state
        .with_storage(|storage| storage.workspace_list())
        .map_err(|error| DesktopError::io(error.to_string()))?
        .iter()
        .any(|workspace| resolved == std::path::Path::new(&workspace.canonical_root));
    if known { Ok(()) } else { Err(DesktopError::untrusted("from the phone, only existing workspaces can be inspected")) }
}

/// Calls one allowed command. Anything else is refused.
pub async fn dispatch(app: &AppHandle, command: &str, args: Value) -> Result<Value, Value> {
    match command {
        "execution_profiles" => Reply::reply(workspace::execution_profiles()),
        "workspace_list" => sync_call!(app, args, workspace::workspace_list),
        "workspace_inspect" => match known_workspace(app, &args) {
            Ok(()) => sync_call!(app, args, workspace::workspace_inspect, "path"),
            Err(error) => refused(error),
        },
        "worktree_list" => sync_call!(app, args, git::worktree_list, "workspaceId"),
        "session_list_open" => sync_call!(app, args, session::session_list_open),
        "session_records" => sync_call!(app, args, session::session_records, "workspaceId"),
        "session_snapshot" => async_call!(app, args, session::session_snapshot, "handle"),
        "session_history" => async_call!(app, args, session::session_history, "request"),
        "session_token_usage" => sync_call!(app, args, session::session_token_usage, "request"),
        "session_submit" => async_call!(app, args, session::session_submit, "request"),
        "session_steer" => async_call!(app, args, session::session_steer, "request"),
        "session_cancel" => async_call!(app, args, session::session_cancel, "handle"),
        "session_set_config_option" => async_call!(app, args, session::session_set_config_option, "request"),
        "session_open" => async_call!(app, args, session::session_open, "request"),
        "session_rename" => sync_call!(app, args, session::session_rename, "request"),
        "session_archive" => sync_call!(app, args, session::session_archive, "request"),
        "session_pin" => sync_call!(app, args, session::session_pin, "request"),
        "session_stop" => async_call!(app, args, session::session_stop, "handle"),
        "outbox_list" => sync_call!(app, args, session::outbox_list, "workspaceId"),
        "odyssey_for_session" => sync_call!(app, args, odyssey::odyssey_for_session, "request"),
        "odyssey_view" => sync_call!(app, args, odyssey::odyssey_view, "id"),
        "odyssey_list" => sync_call!(app, args, odyssey::odyssey_list, "workspaceId"),
        "odyssey_amend_list" => sync_call!(app, args, odyssey::odyssey_amend_list, "odysseyId"),
        "odyssey_amend_document" => sync_call!(app, args, odyssey::odyssey_amend_document, "id"),
        "odyssey_plan_change_list" => sync_call!(app, args, odyssey::odyssey_plan_change_list, "odysseyId"),
        "odyssey_question_list" => sync_call!(app, args, odyssey::odyssey_question_list, "odysseyId"),
        "odyssey_plan_document" => sync_call!(app, args, odyssey::odyssey_plan_document, "id"),
        "odyssey_workspace_notes" => sync_call!(app, args, odyssey::odyssey_workspace_notes, "request"),
        "odyssey_spend_model" => sync_call!(app, args, odyssey::odyssey_spend_model, "odysseyId"),
        "odyssey_create" => sync_call!(app, args, odyssey::odyssey_create, "request"),
        "odyssey_edit_goal" => sync_call!(app, args, odyssey::odyssey_edit_goal, "request"),
        "odyssey_set_state" => sync_call!(app, args, odyssey::odyssey_set_state, "request"),
        "odyssey_add_milestone" => sync_call!(app, args, odyssey::odyssey_add_milestone, "request"),
        "odyssey_edit_milestone" => sync_call!(app, args, odyssey::odyssey_edit_milestone, "request"),
        "odyssey_set_milestone_state" => sync_call!(app, args, odyssey::odyssey_set_milestone_state, "request"),
        "odyssey_add_step" => sync_call!(app, args, odyssey::odyssey_add_step, "request"),
        "odyssey_set_step_state" => sync_call!(app, args, odyssey::odyssey_set_step_state, "request"),
        "odyssey_edit_step" => sync_call!(app, args, odyssey::odyssey_edit_step, "request"),
        "odyssey_question_settle" => sync_call!(app, args, odyssey::odyssey_question_settle, "request"),
        "odyssey_plan_change_decide" => sync_call!(app, args, odyssey::odyssey_plan_change_decide, "request"),
        "odyssey_amend_add" => sync_call!(app, args, odyssey::odyssey_amend_add, "request"),
        "odyssey_amend_set_state" => sync_call!(app, args, odyssey::odyssey_amend_set_state, "request"),
        "odyssey_inspect_refs" => sync_call!(app, args, odyssey::odyssey_inspect_refs, "request"),
        "odyssey_read_plan" => match inside_workspace(app, &args) {
            Ok(()) => sync_call!(app, args, odyssey::odyssey_read_plan, "request"),
            Err(error) => refused(error),
        },
        "odyssey_adopt_plan" => match inside_workspace(app, &args) {
            Ok(()) => sync_call!(app, args, odyssey::odyssey_adopt_plan, "request"),
            Err(error) => refused(error),
        },
        "odyssey_journal_append" => sync_call!(app, args, odyssey::odyssey_journal_append, "request"),
        "bigthing_runtime" => sync_call!(app, args, bigthing::bigthing_runtime, "goalId"),
        "bigthing_briefing" => async_call!(app, args, bigthing::bigthing_briefing, "goalId"),
        "bigthing_commits" => sync_call!(app, args, bigthing::bigthing_commits, "goalId"),
        "bigthing_start" => async_call!(app, args, bigthing::bigthing_start, "goalId"),
        "bigthing_pause" => async_call!(app, args, bigthing::bigthing_pause, "goalId", "reason"),
        "bigthing_tick" => sync_call!(app, args, bigthing::bigthing_tick, "goalId"),
        "bigthing_request_plan" => async_call!(app, args, bigthing::bigthing_request_plan, "goalId"),
        "bigthing_amend" => async_call!(app, args, bigthing::bigthing_amend, "request"),
        "bigthing_decide_plan_change" => async_call!(app, args, bigthing::bigthing_decide_plan_change, "request"),
        "bigthing_answer" => async_call!(app, args, bigthing::bigthing_answer, "request"),
        "bigthing_verify" => async_call!(app, args, bigthing::bigthing_verify, "request"),
        "bigthing_run_check" => async_call!(app, args, bigthing::bigthing_run_check, "request"),
        "bigthing_move" => async_call!(app, args, bigthing::bigthing_move, "request"),
        "memory_list" => sync_call!(app, args, bigthing::memory_list, "request"),
        "memory_write" => sync_call!(app, args, bigthing::memory_write, "request"),
        "delegation_jobs" => sync_call!(app, args, delegation::delegation_jobs, "handle"),
        "delegation_combo_get" => sync_call!(app, args, delegation::delegation_combo_get, "handle"),
        "delegation_default_combo_get" => sync_call!(app, args, delegation::delegation_default_combo_get),
        "delegation_quota" => sync_call!(app, args, delegation::delegation_quota, "provider"),
        "delegation_job_cancel" => async_call!(app, args, delegation::delegation_job_cancel, "request"),
        "delegation_job_retry" => sync_call!(app, args, delegation::delegation_job_retry, "request"),
        "delegation_retry_policy_get" => sync_call!(app, args, delegation::delegation_retry_policy_get),
        "provider_quota" => async_call!(app, args, providers::provider_quota, "provider"),
        "providers_status" => async_call!(app, args, providers::providers_status),
        "provider_models" => async_call!(app, args, providers::provider_models, "provider"),
        "settings_get" => sync_call!(app, args, app_commands::settings_get),
        "app_activity" => async_call!(app, args, app_commands::app_activity),
        "file_read" => sync_call!(app, args, review::file_read, "workspaceId", "relative", "offsetLine", "limit"),
        "workspace_image" => sync_call!(app, args, review::workspace_image, "workspaceId", "relative"),
        "generated_image" => sync_call!(app, args, review::generated_image, "path"),
        "pref_get" => sync_call!(app, args, app_commands::pref_get, "key"),
        "pref_set" => sync_call!(app, args, app_commands::pref_set, "key", "value"),
        "artifacts_list" => sync_call!(app, args, artifacts::artifacts_list, "workspaceId", "agentSessionId"),
        "artifact_read" => sync_call!(app, args, artifacts::artifact_read, "id"),
        "git_info" => sync_call!(app, args, git::git_info, "workspaceId"),
        _ => refused(DesktopError::untrusted(format!("{command} is not available from the phone"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_allowed_command_is_routed_and_nothing_dangerous_is_allowed() {
        let source = include_str!("dispatch.rs");
        for command in ALLOWED {
            assert!(source.contains(&format!("\"{command}\" =>")), "{command} is allowed but not routed");
        }
        for denied in ["workspace_trust", "terminal_open", "terminal_write", "git_push", "git_commit", "file_write_checked", "provider_login_start", "provider_logout", "runtime_env_set", "mcp_install", "settings_set", "odyssey_delete", "bigthing_rollback", "cleanup_run", "open_external", "app_quit", "config_write_file", "skill_create"] {
            assert!(!ALLOWED.contains(&denied), "{denied} must not be reachable from a phone");
        }
    }
}
