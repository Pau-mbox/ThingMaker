//! Teams and jobs (docs/research/multi-provider-viability.md §2.2).
//!
//! Every session the user opens is an orchestrator: it gets the ThingMaker MCP
//! server, and its team (the combo) decides who `delegate` hands work to.
//! Workers are ordinary attachments the host opens here, on whichever
//! provider the combo names, so the user can open one and watch it like any
//! other session. Job changes reach the renderer as `thingmaker://job` events.

use std::{path::PathBuf, sync::Arc};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};
use thingmaker_supervisor::{
    DesktopError, SessionHandle,
    acp::SessionId,
    agents::Provider,
    delegation::{
        Combo, Delegation, JobView, WorkerLauncher, WorkerSpec,
        jobs::{BoxFuture, RetryPolicy},
        orchestrator_guidance,
        socket::{DelegationSocket, RELAY_ARG, server_entry, socket_path},
    },
    storage::{settings::GLOBAL_SCOPE, workspaces::SessionOrigin},
    supervisor::{AgentLaunch, SessionActor, SessionActorConfig, SessionEvent},
};

use super::{CommandResult, storage_error};
use crate::state::AppState;

pub const JOB_EVENT: &str = "thingmaker://job";
/// Settings key for a team: scope `global` for the default a new session
/// starts with, `session:<row id>` for one session's own.
pub const COMBO_KEY: &str = "combo";
/// Settings key (scope `global`) for what a job does after a temporary limit.
pub const RETRY_KEY: &str = "delegationRetry";
/// How long Claude Code waits on one MCP tool call, in milliseconds. It has
/// to outlast `await_jobs`.
const CLAUDE_MCP_TOOL_TIMEOUT_MS: &str = "1800000";

pub fn session_scope(row_id: &str) -> String {
    format!("session:{row_id}")
}

/// Starts the service and its socket; called once from `setup`.
pub fn start(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let launcher = Arc::new(HostLauncher { app: app.clone() });
    let emitter = app.clone();
    let delegation = Delegation::new(launcher, move |job: &JobView| {
        let _ = emitter.emit(JOB_EVENT, job);
        // Super Thing follows the jobs it gave out, and the tasks they are named after.
        if let Some(engine) = emitter.try_state::<AppState>().and_then(|state| state.engine.get().cloned()) {
            engine.note_job(job);
        }
    });
    let path = socket_path(&state.data_dir);
    let socket = tauri::async_runtime::block_on(async { DelegationSocket::bind(delegation.clone(), path) }).map_err(|error| format!("could not open the ThingMaker MCP socket: {error}"))?;
    tracing::info!(path = %socket.path().display(), "ThingMaker MCP socket listening");
    if let Ok(Some(policy)) = state.with_storage(|s| s.setting_get::<RetryPolicy>(RETRY_KEY, GLOBAL_SCOPE)) {
        delegation.set_retry_policy(policy);
    }
    let _ = state.delegation.set(delegation);
    let _ = state.delegation_socket.set(socket);
    Ok(())
}

/// The program an agent starts as its ThingMaker MCP server: this executable,
/// which relays instead of opening a window when given [`RELAY_ARG`].
fn relay_program() -> Option<PathBuf> {
    std::env::var_os("THINGMAKER_MCP_PROGRAM").map(PathBuf::from).or_else(|| std::env::current_exe().ok())
}

/// The team a session starts with: the one asked for, else the one it had
/// last time, else the user's default.
pub fn starting_combo(state: &AppState, requested: Option<Combo>, row_id: Option<&str>) -> Combo {
    if let Some(combo) = requested {
        return combo.normalized();
    }
    let stored = row_id.and_then(|id| state.with_storage(|s| s.setting_get::<Combo>(COMBO_KEY, &session_scope(id))).ok().flatten());
    stored
        .or_else(|| state.with_storage(|s| s.setting_get::<Combo>(COMBO_KEY, GLOBAL_SCOPE)).ok().flatten())
        .unwrap_or_default()
        .normalized()
}

/// Makes the attachment about to open an orchestrator: registers it, hands
/// it the ThingMaker MCP server, and tells it about its team. Without the
/// service (it failed to start) the session opens as a plain one.
pub fn prepare_orchestrator(state: &AppState, key: &str, root: PathBuf, combo: &Combo, launch: &mut AgentLaunch, config: &mut SessionActorConfig) {
    // A provider that cannot take the session's own MCP server cannot lead
    // a team: it opens as a plain session.
    if !launch.provider().can_orchestrate() {
        return;
    }
    let (Some(delegation), Some(socket), Some(program)) = (state.delegation.get(), state.delegation_socket.get(), relay_program()) else {
        return;
    };
    let token = delegation.register(key, launch.provider(), root, combo.clone());
    config.mcp_servers = vec![server_entry(&program, &[RELAY_ARG.to_string()], socket.path(), &token)];
    let withheld = combo.withholds_native_subagents();
    let guidance = orchestrator_guidance(withheld);
    match launch {
        AgentLaunch::Claude(options) => {
            if withheld {
                options.disallowed_tools = vec!["Agent".into(), "Task".into()];
            }
            options.append_system_prompt = Some(guidance);
            config.environment = config.environment.clone().with_set("MCP_TOOL_TIMEOUT", CLAUDE_MCP_TOOL_TIMEOUT_MS);
        }
        AgentLaunch::Codex(options) => {
            if withheld {
                options.config.insert(thingmaker_supervisor::agents::codex::launch::MULTI_AGENT_FEATURE.into(), serde_json::Value::Bool(false));
            }
            options.developer_instructions = Some(guidance);
        }
        AgentLaunch::Gemini(_) => {}
    }
}

/// After the orchestrator is open: its quota reports feed the router.
pub fn watch_orchestrator(state: &AppState, actor: &SessionActor) {
    let Some(delegation) = state.delegation.get().cloned() else { return };
    let mut subscription = actor.subscribe();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = subscription.recv().await {
            match &event.payload {
                SessionEvent::Quota(snapshot) => delegation.note_quota(snapshot.clone()),
                SessionEvent::Exited(_) => break,
                _ => {}
            }
        }
    });
}

/// Forgets an orchestrator and stops its workers.
pub async fn release(state: &AppState, key: &str) {
    if let Some(delegation) = state.delegation.get() {
        delegation.release(key).await;
    }
}

struct HostLauncher {
    app: AppHandle,
}

impl WorkerLauncher for HostLauncher {
    fn launch(&self, spec: WorkerSpec) -> BoxFuture<Result<SessionActor, DesktopError>> {
        let app = self.app.clone();
        Box::pin(async move {
            let state = app.state::<AppState>();
            let root = spec.root.to_string_lossy().into_owned();
            let record = state
                .with_storage(|s| s.workspace_by_root(&root))
                .map_err(storage_error)?
                .ok_or_else(|| DesktopError::not_ready("the orchestrator's workspace is gone"))?;
            let record = super::workspace::ensure_trusted(&state, record)?;
            let reserved = SessionId::reserve();
            let (target, launch) = super::session::build_launch(&state, &record, spec.slot.provider, spec.slot.model.clone(), spec.slot.effort.clone(), None, reserved.clone())?;
            let mut config = SessionActorConfig::new(target, launch);
            config.environment = super::session::launch_environment(&state);
            // The worker's own reduced team server: the project memory and the
            // run's board (ADR-010). A provider that cannot load one goes without.
            if let (Some(token), Some(socket), Some(program)) = (spec.mcp_token.as_deref(), state.delegation_socket.get(), relay_program())
                && spec.slot.provider.can_orchestrate()
            {
                config.mcp_servers = vec![server_entry(&program, &[RELAY_ARG.to_string()], socket.path(), token)];
                if spec.slot.provider == Provider::Claude {
                    config.environment = config.environment.clone().with_set("MCP_TOOL_TIMEOUT", CLAUDE_MCP_TOOL_TIMEOUT_MS);
                }
            }
            let actor = SessionActor::open(config).await?;
            let snapshot = actor.snapshot().await?;
            let recorded = snapshot.agent_session_id.clone().unwrap_or_else(|| reserved.as_str().to_string());
            let row = state
                .with_storage(|s| s.session_upsert(&record.id, &recorded, SessionOrigin::Desktop, spec.slot.provider))
                .map_err(storage_error)?;
            let parent_agent_id = state.agent_session_id(&spec.orchestrator);
            let parent = state.with_storage(|s| s.session_by_agent_id(&record.id, &parent_agent_id)).ok().flatten();
            let _ = state.with_storage(|s| {
                s.session_set_parent(&row.id, parent.as_ref().map(|parent| parent.id.as_str()))?;
                s.session_set_title_overlay(&row.id, Some(&spec.title))
            });
            state.insert_actor(actor.handle().id.clone(), recorded, actor.clone(), spec.root.clone());
            state.set_actor_model(&actor.handle().id, spec.slot.model.as_deref());
            Ok(actor)
        })
    }

    fn released(&self, worker_handle: &str) {
        if let Some(state) = self.app.try_state::<AppState>() {
            state.remove_actor(worker_handle);
        }
    }
}

fn delegation(state: &AppState) -> CommandResult<&Delegation> {
    state.delegation.get().ok_or_else(|| DesktopError::not_ready("delegation is not available: the team socket did not start"))
}

/// The desktop row of a live attachment, for persisting its team.
fn row_id(state: &AppState, handle: &SessionHandle) -> Option<String> {
    let agent_id = state.agent_session_id(&handle.id);
    let (_, root) = state.actor_entries().into_iter().find(|(id, _)| *id == handle.id)?;
    let workspace = state.with_storage(|s| s.workspace_by_root(&root.to_string_lossy())).ok().flatten()?;
    state.with_storage(|s| s.session_by_agent_id(&workspace.id, &agent_id)).ok().flatten().map(|row| row.id)
}

/// A live session's team.
#[tauri::command]
pub fn delegation_combo_get(handle: SessionHandle, state: State<'_, AppState>) -> CommandResult<Option<Combo>> {
    Ok(delegation(&state)?.combo(&handle.id))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComboSetRequest {
    pub handle: SessionHandle,
    pub combo: Combo,
}

/// Changes a live session's team; the next `delegate` uses it. Kept for the
/// session's next attachment too.
#[tauri::command]
pub fn delegation_combo_set(request: ComboSetRequest, state: State<'_, AppState>) -> CommandResult<Combo> {
    if request.combo.workers.len() > 16 {
        return Err(DesktopError::io("a team has at most 16 workers"));
    }
    let combo = delegation(&state)?.set_combo(&request.handle.id, request.combo)?;
    if let Some(row) = row_id(&state, &request.handle) {
        state.with_storage(|s| s.setting_set(COMBO_KEY, &session_scope(&row), &combo)).map_err(storage_error)?;
    }
    Ok(combo)
}

/// The team a new session starts with.
#[tauri::command]
pub fn delegation_default_combo_get(state: State<'_, AppState>) -> CommandResult<Combo> {
    Ok(state.with_storage(|s| s.setting_get::<Combo>(COMBO_KEY, GLOBAL_SCOPE)).map_err(storage_error)?.unwrap_or_default())
}

#[tauri::command]
pub fn delegation_default_combo_set(combo: Combo, state: State<'_, AppState>) -> CommandResult<Combo> {
    let combo = combo.normalized();
    state.with_storage(|s| s.setting_set(COMBO_KEY, GLOBAL_SCOPE, &combo)).map_err(storage_error)?;
    Ok(combo)
}

/// A live session's jobs, oldest first.
#[tauri::command]
pub fn delegation_jobs(handle: SessionHandle, state: State<'_, AppState>) -> CommandResult<Vec<JobView>> {
    Ok(delegation(&state)?.jobs(&handle.id))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCancelRequest {
    pub handle: SessionHandle,
    pub job_id: String,
}

#[tauri::command]
pub async fn delegation_job_cancel(request: JobCancelRequest, state: State<'_, AppState>) -> CommandResult<JobView> {
    delegation(&state)?.cancel(&request.handle.id, &request.job_id).await.map_err(DesktopError::not_ready)
}

/// Whether a provider is spent as far as the router knows, for the picker.
#[tauri::command]
pub fn delegation_quota(provider: Provider, state: State<'_, AppState>) -> CommandResult<Option<thingmaker_supervisor::agents::events::QuotaSnapshot>> {
    Ok(delegation(&state)?.quota(provider))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRetryRequest {
    pub handle: SessionHandle,
    pub job_id: String,
}

/// Ends a waiting job's wait now.
#[tauri::command]
pub fn delegation_job_retry(request: JobRetryRequest, state: State<'_, AppState>) -> CommandResult<JobView> {
    delegation(&state)?.retry_now(&request.handle.id, &request.job_id).map_err(DesktopError::not_ready)
}

/// What a job does after a temporary limit.
#[tauri::command]
pub fn delegation_retry_policy_get(state: State<'_, AppState>) -> CommandResult<RetryPolicy> {
    Ok(delegation(&state)?.retry_policy())
}

#[tauri::command]
pub fn delegation_retry_policy_set(policy: RetryPolicy, state: State<'_, AppState>) -> CommandResult<RetryPolicy> {
    let policy = RetryPolicy {
        first_delay_secs: policy.first_delay_secs.clamp(30, 6 * 3600),
        step_secs: policy.step_secs.min(6 * 3600),
        max_delay_secs: policy.max_delay_secs.clamp(30, 12 * 3600),
        max_attempts: policy.max_attempts.min(50),
        max_wait_secs: policy.max_wait_secs.clamp(60, 24 * 3600),
        ..policy
    };
    state.with_storage(|s| s.setting_set(RETRY_KEY, GLOBAL_SCOPE, &policy)).map_err(storage_error)?;
    delegation(&state)?.set_retry_policy(policy);
    Ok(policy)
}
