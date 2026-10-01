//! Providers: where each one's program is, whether it is signed in, how to
//! sign in, and which models the account can select.
//!
//! Every answer comes from the provider's own official program. The desktop
//! runs it as a separate process, never reads or stores a token, and only
//! surfaces a sign-in URL for the user to click (SEC-06).

use std::{path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{State, ipc::Channel};
use thingmaker_supervisor::{
    DesktopError,
    agents::{
        Provider,
        auth::{ProviderAuthStatus, ProviderModel},
        auth::run_bounded,
        claude, codex, gemini,
        login::{LoginEvent, run_login_process},
    },
    security::EnvironmentProfile,
};

use super::{CommandResult, storage_error};
use crate::state::{AppState, PROVIDER_LOCATION_KEY, ProviderLocation, ResolvedProvider};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub provider: Provider,
    pub label: &'static str,
    /// Where the program is, when it was found.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved: Option<ResolvedProvider>,
    /// Why it could not be found or asked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<ProviderAuthStatus>,
}

fn auth_status(resolved: &ResolvedProvider) -> ProviderAuthStatus {
    match resolved.provider {
        Provider::Claude => claude::auth::read_status(&resolved.program, &resolved.prefix_args, Duration::from_secs(30)),
        Provider::Codex => codex::probe::read_status(&resolved.program, None, Duration::from_secs(30)),
        Provider::Gemini => gemini::probe::read_status(&resolved.program, Duration::from_secs(30)),
    }
}

/// Every provider this build knows, with its program and sign-in state.
/// Asking can take a few seconds per provider (each answers through its own
/// CLI), so this runs off the command thread.
#[tauri::command]
pub async fn providers_status(state: State<'_, AppState>) -> CommandResult<Vec<ProviderInfo>> {
    let resolved: Vec<(Provider, Result<ResolvedProvider, DesktopError>)> =
        Provider::ALL.iter().map(|provider| (*provider, state.resolve_provider(*provider))).collect();
    tauri::async_runtime::spawn_blocking(move || {
        resolved
            .into_iter()
            .map(|(provider, resolved)| match resolved {
                Ok(resolved) => ProviderInfo {
                    provider,
                    label: provider.label(),
                    auth: Some(auth_status(&resolved)),
                    resolved: Some(resolved),
                    problem: None,
                },
                Err(error) => ProviderInfo { provider, label: provider.label(), resolved: None, problem: Some(error.message), auth: None },
            })
            .collect()
    })
    .await
    .map_err(|error| DesktopError::io(error.to_string()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLocationRequest {
    pub provider: Provider,
    /// `None` clears the choice and goes back to discovery.
    pub location: Option<ProviderLocation>,
}

/// Records where a provider's program is, or clears the choice.
#[tauri::command]
pub fn provider_set_location(request: ProviderLocationRequest, state: State<'_, AppState>) -> CommandResult<()> {
    let scope = format!("provider:{}", request.provider.as_str());
    match request.location {
        Some(location) => {
            if !location.program.is_file() {
                return Err(DesktopError::not_ready(format!("{} does not exist", location.program.display())));
            }
            if let Some(script) = &location.script
                && !script.is_file()
            {
                return Err(DesktopError::not_ready(format!("{} does not exist", script.display())));
            }
            state.with_storage(|s| s.setting_set(PROVIDER_LOCATION_KEY, &scope, &location)).map_err(storage_error)
        }
        None => state.with_storage(|s| s.setting_delete(PROVIDER_LOCATION_KEY, &scope)).map_err(storage_error),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStartResponse {
    pub run_id: String,
}

/// Starts a provider's own sign-in and streams what it prints.
///
/// Claude Code signs in with `--claudeai`, which is what makes the work count
/// against a Claude *subscription* rather than metered API billing — this
/// desktop runs on subscriptions only.
#[tauri::command]
pub fn provider_login_start(provider: Provider, on_event: Channel<LoginEvent>, state: State<'_, AppState>) -> CommandResult<LoginStartResponse> {
    let resolved = state.resolve_provider(provider)?;
    // Both sign in with the subscription: Claude Code's `--claudeai`, and
    // `codex login`, which is ChatGPT sign-in unless an API key is given.
    // `agy` has no headless sign-in; it shares the Antigravity app's.
    let (args, environment) = match provider {
        Provider::Claude => (claude::auth::login_args(&resolved.prefix_args, true), EnvironmentProfile::trusted_local()),
        Provider::Codex => (codex::probe::login_args(), codex::probe::environment(None)),
        Provider::Gemini => return Err(DesktopError::unsupported(gemini::probe::SIGN_IN_HINT)),
    };
    let program: PathBuf = resolved.program;
    let run_id = thingmaker_supervisor::storage::new_id();
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    state.auth_runs.lock().unwrap_or_else(|p| p.into_inner()).insert(run_id.clone(), cancel_tx);
    let run_id_for_task = run_id.clone();
    let runs = state.auth_runs_arc();
    tauri::async_runtime::spawn(async move {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<LoginEvent>(256);
        let forward = tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                if on_event.send(event).is_err() {
                    break;
                }
            }
        });
        let outcome = run_login_process(&program, &args, &environment, Duration::from_secs(10 * 60), tx, cancel_rx).await;
        if let Err(error) = outcome {
            tracing::warn!(?error, "provider sign-in failed to run");
        }
        let _ = forward.await;
        runs.lock().unwrap_or_else(|p| p.into_inner()).remove(&run_id_for_task);
    });
    Ok(LoginStartResponse { run_id })
}

#[tauri::command]
pub fn provider_login_cancel(run_id: String, state: State<'_, AppState>) -> CommandResult<bool> {
    let sender = state.auth_runs.lock().unwrap_or_else(|p| p.into_inner()).remove(&run_id);
    Ok(match sender {
        Some(sender) => sender.send(()).is_ok(),
        None => false,
    })
}

/// The models this account can select, from the provider itself.
#[tauri::command]
pub async fn provider_models(provider: Provider, state: State<'_, AppState>) -> CommandResult<Vec<ProviderModel>> {
    let resolved = state.resolve_provider(provider)?;
    // The app's own data directory, not a project: asking for the catalog
    // opens a session, and that should leave nothing in the user's workspace.
    let scratch = state.data_dir.join("provider-probe");
    tauri::async_runtime::spawn_blocking(move || match provider {
        Provider::Claude => claude::auth::read_models(&resolved.program, &resolved.prefix_args, &scratch, Duration::from_secs(45)).map_err(DesktopError::io),
        Provider::Codex => codex::probe::read_models(&resolved.program, None, Duration::from_secs(45)).map_err(DesktopError::io),
        Provider::Gemini => gemini::probe::read_models(&resolved.program, Duration::from_secs(45)).map_err(DesktopError::io),
    })
    .await
    .map_err(|error| DesktopError::io(error.to_string()))?
}

/// Asks a provider for its account's quota now, rather than waiting for the
/// next report on a session's stream.
///
/// Codex answers `account/rateLimits/read` on demand. Claude Code has no such
/// question: it reports on every turn and, once spent, in the refusal, so for
/// Claude this is unsupported and the caller relies on those reports.
#[tauri::command]
pub async fn provider_quota(provider: Provider, state: State<'_, AppState>) -> CommandResult<thingmaker_supervisor::agents::events::QuotaSnapshot> {
    let resolved = state.resolve_provider(provider)?;
    let home = state.home.clone().unwrap_or_default();
    let snapshot = match provider {
        // Claude Code is asked for its own `/usage` data; the adapter's
        // script locates the Claude Code binary it ships with.
        Provider::Claude => {
            let script = resolved.prefix_args.first().map(std::path::PathBuf::from).unwrap_or_default();
            let binary = claude::usage_probe::locate_claude_binary(&script, &home)
                .ok_or_else(|| DesktopError::not_ready("Claude Code's own program was not found beside the adapter"))?;
            tauri::async_runtime::spawn_blocking(move || claude::usage_probe::read_quota(&binary, Duration::from_secs(30)).map_err(DesktopError::io))
                .await
                .map_err(|error| DesktopError::io(error.to_string()))??
        }
        Provider::Codex => tauri::async_runtime::spawn_blocking(move || codex::probe::read_quota(&resolved.program, None, Duration::from_secs(30)).map_err(DesktopError::io))
            .await
            .map_err(|error| DesktopError::io(error.to_string()))??,
        // `agy` reports usage per turn but has no quota question.
        Provider::Gemini => return Err(DesktopError::unsupported("Antigravity does not report its quota; a spent account shows as a refused turn.")),
    };
    // The router places work by the same reading the sidebar shows.
    if let Some(delegation) = state.delegation.get() {
        delegation.note_quota(snapshot.clone());
    }
    Ok(snapshot)
}

/// Signs a provider's program out of its own store, so the next sign-in can
/// be a different account. The provider's own command does it; nothing here
/// touches a credential file.
#[tauri::command]
pub async fn provider_logout(provider: Provider, state: State<'_, AppState>) -> CommandResult<()> {
    let resolved = state.resolve_provider(provider)?;
    let (args, environment) = match provider {
        Provider::Claude => (claude::auth::logout_args(&resolved.prefix_args), EnvironmentProfile::trusted_local()),
        Provider::Codex => (codex::probe::logout_args(), codex::probe::environment(None)),
        Provider::Gemini => {
            return Err(DesktopError::unsupported("Antigravity signs in and out through its own app: switch the account there, or run `agy` in a terminal."));
        }
    };
    let program = resolved.program;
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = std::process::Command::new(&program);
        command.args(&args).env_clear().envs(environment.resolve(std::env::vars())).stdin(std::process::Stdio::null());
        let output = run_bounded(command, Duration::from_secs(30)).map_err(DesktopError::io)?;
        if output.status.success() {
            Ok(())
        } else {
            let detail = String::from_utf8_lossy(&output.stderr).trim().chars().take(400).collect::<String>();
            Err(DesktopError::io(format!("sign-out failed{}", if detail.is_empty() { String::new() } else { format!(": {detail}") })))
        }
    })
    .await
    .map_err(|error| DesktopError::io(error.to_string()))?
}

/// Opens a URL in the system browser after validation. Only http(s) URLs are
/// accepted; the user triggers this explicitly from a displayed URL (SEC-06).
#[tauri::command]
pub fn open_external(url: String, app: tauri::AppHandle) -> CommandResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let trimmed = url.trim();
    let allowed = trimmed.starts_with("https://") || trimmed.starts_with("http://127.0.0.1") || trimmed.starts_with("http://localhost");
    if !allowed || trimmed.len() > 4096 || trimmed.chars().any(char::is_control) {
        return Err(DesktopError::unsupported("Only https URLs (or loopback http) can be opened from the desktop."));
    }
    app.opener()
        .open_url(trimmed, None::<&str>)
        .map_err(|error| DesktopError::io(format!("could not open the browser: {error}")))
}
