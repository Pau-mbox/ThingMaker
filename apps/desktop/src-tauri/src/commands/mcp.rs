//! MCP servers in the Integrations panel: what each provider has, one-click
//! installs from a small catalog, a pasted config or command, and a test
//! start before anything is written.
//!
//! Installing runs each provider's own `mcp add` (see
//! `thingmaker_supervisor::integrations::mcp`), so a server lands where that
//! provider reads it and applies to its next session, in ThingMaker or not.

use std::{collections::HashMap, path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::State;
use thingmaker_supervisor::{
    DesktopError,
    agents::{Provider, claude::usage_probe::locate_claude_binary},
    integrations::mcp::{self, CatalogEntry, ConfigHomes, InstalledServer, McpScope, McpServerSpec, ProbeResult},
};

use super::{CommandResult, storage_error};
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderMcp {
    pub provider: Provider,
    /// Whether this provider's `mcp` command can be run.
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOverview {
    pub servers: Vec<InstalledServer>,
    pub providers: Vec<ProviderMcp>,
    /// The workspace root, which a catalog entry's `{folder}` becomes.
    pub folder: Option<String>,
}

fn root_of(state: &AppState, workspace_id: Option<&str>) -> CommandResult<Option<PathBuf>> {
    let Some(id) = workspace_id else { return Ok(None) };
    let record = state.with_storage(|s| s.workspace_get(id)).map_err(storage_error)?.ok_or_else(|| DesktopError::not_ready("workspace not found"))?;
    Ok(Some(PathBuf::from(record.canonical_root)))
}

/// The program whose `mcp` subcommand manages a provider's servers.
fn program(state: &AppState, provider: Provider) -> CommandResult<PathBuf> {
    let resolved = state.resolve_provider(provider)?;
    match provider {
        // Claude Code's own CLI, the one the adapter ships with.
        Provider::Claude => {
            let script = resolved.prefix_args.first().map(PathBuf::from).unwrap_or_default();
            locate_claude_binary(&script, &state.home.clone().unwrap_or_default()).ok_or_else(|| DesktopError::not_ready("Claude Code's own program was not found beside the adapter"))
        }
        Provider::Codex | Provider::Gemini => Ok(resolved.program),
    }
}

/// The environment a session gets: the app's baseline, the tool folders on
/// PATH and the runtime variables from the keychain.
fn session_env(state: &AppState) -> HashMap<String, String> {
    super::session::launch_environment(state).resolve(std::env::vars()).into_iter().collect()
}

#[tauri::command]
pub fn mcp_overview(workspace_id: Option<String>, state: State<'_, AppState>) -> CommandResult<McpOverview> {
    let home = state.home.clone().ok_or_else(|| DesktopError::not_ready("HOME is not set"))?;
    let root = root_of(&state, workspace_id.as_deref())?;
    let servers = mcp::installed(&ConfigHomes::from_env(&home), root.as_deref());
    let providers = Provider::ALL
        .into_iter()
        .map(|provider| match program(&state, provider) {
            Ok(_) => ProviderMcp { provider, available: true, problem: None },
            Err(error) => ProviderMcp { provider, available: false, problem: Some(error.message) },
        })
        .collect();
    Ok(McpOverview { servers, providers, folder: root.map(|root| root.to_string_lossy().into_owned()) })
}

#[tauri::command]
pub fn mcp_catalog() -> Vec<CatalogEntry> {
    mcp::catalog()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseRequest {
    pub text: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// Reads a pasted config or command into servers, for review before install.
#[tauri::command]
pub fn mcp_parse(request: ParseRequest) -> CommandResult<Vec<McpServerSpec>> {
    mcp::parse_snippet(&request.text, request.name.as_deref()).map_err(DesktopError::io)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    pub workspace_id: Option<String>,
    pub spec: McpServerSpec,
    pub providers: Vec<Provider>,
    #[serde(default = "user_scope")]
    pub scope: McpScope,
}

fn user_scope() -> McpScope {
    McpScope::User
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub provider: Provider,
    pub ok: bool,
    pub message: String,
}

async fn run(program: PathBuf, args: Vec<String>, cwd: PathBuf, env: HashMap<String, String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = std::process::Command::new(&program)
            .args(&args)
            .current_dir(&cwd)
            .env_clear()
            .envs(&env)
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|error| format!("could not run {}: {error}", program.display()))?;
        let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).trim().to_string();
        if output.status.success() {
            Ok(text(&output.stdout))
        } else {
            let stderr = text(&output.stderr);
            Err(if stderr.is_empty() { text(&output.stdout) } else { stderr })
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Installs a server into each chosen provider, through its own CLI.
#[tauri::command]
pub async fn mcp_install(request: InstallRequest, state: State<'_, AppState>) -> CommandResult<Vec<InstallOutcome>> {
    if request.providers.is_empty() {
        return Err(DesktopError::io("choose at least one provider"));
    }
    let home = state.home.clone().ok_or_else(|| DesktopError::not_ready("HOME is not set"))?;
    let root = root_of(&state, request.workspace_id.as_deref())?;
    if request.scope == McpScope::Local && root.is_none() {
        return Err(DesktopError::io("a project-only server needs a workspace"));
    }
    let env = session_env(&state);
    let cwd = root.clone().unwrap_or_else(|| home.clone());
    let mut outcomes = Vec::new();
    for provider in request.providers {
        let scope = if provider == Provider::Claude { request.scope } else { McpScope::User };
        let outcome = async {
            let args = mcp::install_args(provider, &request.spec, scope)?;
            let program = program(&state, provider).map_err(|error| error.message)?;
            let said = run(program, args, cwd.clone(), env.clone()).await?;
            if provider == Provider::Codex {
                let variables = mcp::references(&request.spec);
                mcp::codex_forward_env(&ConfigHomes::from_env(&home).codex_config(), &request.spec.name, &variables).map_err(|error| error.message)?;
            }
            Ok::<_, String>(said)
        }
        .await;
        outcomes.push(match outcome {
            Ok(said) => InstallOutcome { provider, ok: true, message: if said.is_empty() { format!("Added {}", request.spec.name) } else { said } },
            Err(error) => InstallOutcome { provider, ok: false, message: error },
        });
    }
    Ok(outcomes)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveRequest {
    pub workspace_id: Option<String>,
    pub provider: Provider,
    pub name: String,
    pub scope: McpScope,
}

#[tauri::command]
pub async fn mcp_remove(request: RemoveRequest, state: State<'_, AppState>) -> CommandResult<String> {
    if request.scope == McpScope::Project {
        return Err(DesktopError::unsupported("this server is in the project's shared .mcp.json; edit that file to remove it"));
    }
    let home = state.home.clone().ok_or_else(|| DesktopError::not_ready("HOME is not set"))?;
    let cwd = root_of(&state, request.workspace_id.as_deref())?.unwrap_or(home);
    let program = program(&state, request.provider)?;
    run(program, mcp::remove_args(request.provider, &request.name, request.scope), cwd, session_env(&state)).await.map_err(DesktopError::io)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRequest {
    pub workspace_id: Option<String>,
    pub spec: McpServerSpec,
}

/// Starts the server the way a session would and lists its tools.
#[tauri::command]
pub async fn mcp_test(request: TestRequest, state: State<'_, AppState>) -> CommandResult<ProbeResult> {
    let home = state.home.clone().ok_or_else(|| DesktopError::not_ready("HOME is not set"))?;
    let cwd = root_of(&state, request.workspace_id.as_deref())?.unwrap_or(home);
    let env = session_env(&state);
    tauri::async_runtime::spawn_blocking(move || mcp::probe(&request.spec, &env, &cwd, Duration::from_secs(90)))
        .await
        .map_err(|error| DesktopError::io(error.to_string()))?
        .map_err(DesktopError::io)
}
