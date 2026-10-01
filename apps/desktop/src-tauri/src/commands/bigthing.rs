//! Big Thing's engine in the host (ADR-010).
//!
//! The engine lives in the supervisor and runs every goal; this is its host:
//! it finds and opens sessions the way the user's own tabs are opened, asks
//! the accounts for their usage, and tells the interface what happened on
//! `thingmaker://bigthing`. The commands below are the user's buttons; they
//! hand the action to the engine, which writes it to the record and acts.

use std::path::Path;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};
use thingmaker_supervisor::{
    DesktopError,
    agents::{Provider, events::QuotaSnapshot},
    delegation::jobs::BoxFuture,
    review::git::MergeOutcome,
    storage::{
        memory::{MemoryEntry, MemoryWrite},
        odyssey::NewAmendment,
    },
    bigthing::{Engine, EngineEvent, EngineHost, LiveSession, MoveTarget, OpenSpec, RuntimeView, TICK_INTERVAL, worktree::RunCommit},
};

use super::{CommandResult, storage_error};
use crate::state::AppState;

pub const BIGTHING_EVENT: &str = "thingmaker://bigthing";

/// Starts the engine; called once from `setup`, after delegation.
pub fn start(app: &AppHandle) {
    let state = app.state::<AppState>();
    let host = std::sync::Arc::new(HostEngine { app: app.clone() });
    let engine = Engine::new(state.storage.clone(), host, state.delegation.get().cloned(), state.data_dir.clone());
    if let Some(delegation) = state.delegation.get() {
        delegation.set_extension(std::sync::Arc::new(engine.clone()));
    }
    let _ = state.engine.set(engine.clone());
    tauri::async_runtime::spawn(async move { engine.start(TICK_INTERVAL) });
}

struct HostEngine {
    app: AppHandle,
}

impl HostEngine {
    fn state(&self) -> State<'_, AppState> {
        self.app.state::<AppState>()
    }

    fn live_by(&self, handle: &str) -> Option<LiveSession> {
        let state = self.state();
        let actor = state.actor(handle)?;
        let root = state.actor_entries().into_iter().find(|(id, _)| id == handle).map(|(_, root)| root)?;
        let agent_session_id = state.agent_session_id(handle);
        let workspace = state.with_storage(|s| s.workspace_by_root(&root.to_string_lossy())).ok().flatten()?;
        let row = state.with_storage(|s| s.session_by_agent_id(&workspace.id, &agent_session_id)).ok().flatten()?;
        let model = state.actor_model(handle);
        Some(LiveSession { actor, handle: handle.to_string(), agent_session_id, row_id: row.id, workspace_id: workspace.id, provider: row.provider, root, model })
    }
}

impl EngineHost for HostEngine {
    fn live(&self, row_id: &str) -> Option<LiveSession> {
        let state = self.state();
        let row = state.with_storage(|s| s.session_get(row_id)).ok().flatten()?;
        let handle = state.actor_ids().into_iter().find(|id| state.agent_session_id(id) == row.agent_session_id)?;
        self.live_by(&handle)
    }

    fn live_handle(&self, handle: &str) -> Option<LiveSession> {
        self.live_by(handle)
    }

    fn open(&self, spec: OpenSpec) -> BoxFuture<Result<LiveSession, DesktopError>> {
        let app = self.app.clone();
        Box::pin(async move {
            let host = HostEngine { app: app.clone() };
            let mode = match spec.resume {
                Some(session_id) => super::session::OpenRequestMode::Resume { session_id },
                None => super::session::OpenRequestMode::New,
            };
            let request = super::session::OpenRequest { workspace_id: spec.workspace_id, mode, provider: Some(spec.provider), model: spec.model, reasoning_effort: spec.effort, combo: spec.combo };
            let opened = super::session::session_open(request, app.state::<AppState>()).await?;
            host.live_by(&opened.handle.id).ok_or_else(|| DesktopError::not_ready("the session opened but is not attached"))
        })
    }

    fn quota(&self, provider: Provider) -> BoxFuture<Option<QuotaSnapshot>> {
        let app = self.app.clone();
        Box::pin(async move {
            if provider == Provider::Gemini {
                return None;
            }
            super::providers::provider_quota(provider, app.state::<AppState>()).await.ok()
        })
    }

    fn session_tokens(&self, session: &LiveSession) -> Option<i64> {
        let request = super::session::TokenUsageRequest { workspace_id: session.workspace_id.clone(), agent_session_id: session.agent_session_id.clone() };
        let usage = super::session::session_token_usage(request, self.state()).ok()?;
        Some((usage.totals.paid_input_tokens + usage.totals.output_tokens) as i64)
    }

    fn install_skill(&self) -> bool {
        super::odyssey::odyssey_install_skill(self.state()).is_ok()
    }

    fn install_delegate(&self, root: &Path) -> bool {
        let state = self.state();
        let Some(workspace) = state.with_storage(|s| s.workspace_by_root(&root.to_string_lossy())).ok().flatten() else { return false };
        super::odyssey::odyssey_install_delegate(workspace.id, state).is_ok()
    }

    fn usable_providers(&self) -> Vec<Provider> {
        let state = self.state();
        Provider::ALL.into_iter().filter(|provider| state.resolve_provider(*provider).is_ok()).collect()
    }

    fn emit(&self, event: EngineEvent) {
        let _ = self.app.emit(BIGTHING_EVENT, &event);
    }
}

fn engine(state: &AppState) -> CommandResult<Engine> {
    state.engine.get().cloned().ok_or_else(|| DesktopError::not_ready("Big Thing's engine did not start"))
}

#[tauri::command]
pub async fn bigthing_start(goal_id: String, state: State<'_, AppState>) -> CommandResult<()> {
    engine(&state)?.start_goal(&goal_id).await
}

#[tauri::command]
pub async fn bigthing_pause(goal_id: String, reason: Option<String>, state: State<'_, AppState>) -> CommandResult<()> {
    engine(&state)?.pause(&goal_id, reason.as_deref()).await
}

/// Asks the engine to look at a goal now rather than on its next tick.
#[tauri::command]
pub fn bigthing_tick(goal_id: String, state: State<'_, AppState>) -> CommandResult<()> {
    engine(&state)?.nudge(&goal_id);
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveRequest {
    pub goal_id: String,
    pub target: MoveTarget,
}

#[tauri::command]
pub async fn bigthing_move(request: MoveRequest, state: State<'_, AppState>) -> CommandResult<()> {
    engine(&state)?.move_goal(&request.goal_id, request.target).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneRequest {
    pub goal_id: String,
    pub milestone_id: String,
}

#[tauri::command]
pub async fn bigthing_verify(request: MilestoneRequest, state: State<'_, AppState>) -> CommandResult<()> {
    engine(&state)?.verify(&request.goal_id, &request.milestone_id).await
}

#[tauri::command]
pub async fn bigthing_run_check(request: MilestoneRequest, state: State<'_, AppState>) -> CommandResult<()> {
    engine(&state)?.run_check(&request.goal_id, &request.milestone_id).await
}

#[tauri::command]
pub async fn bigthing_request_plan(goal_id: String, state: State<'_, AppState>) -> CommandResult<()> {
    engine(&state)?.request_plan(&goal_id).await
}

#[tauri::command]
pub async fn bigthing_amend(request: NewAmendment, state: State<'_, AppState>) -> CommandResult<()> {
    engine(&state)?.add_amendment(request).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanChangeDecision {
    pub goal_id: String,
    pub id: String,
    pub apply: bool,
    #[serde(default)]
    pub note: Option<String>,
}

#[tauri::command]
pub async fn bigthing_decide_plan_change(request: PlanChangeDecision, state: State<'_, AppState>) -> CommandResult<()> {
    engine(&state)?.decide_plan_change(&request.goal_id, &request.id, request.apply, request.note.as_deref()).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerRequest {
    pub goal_id: String,
    pub id: String,
    #[serde(default)]
    pub answer: Option<String>,
}

#[tauri::command]
pub async fn bigthing_answer(request: AnswerRequest, state: State<'_, AppState>) -> CommandResult<()> {
    engine(&state)?.answer_question(&request.goal_id, &request.id, request.answer.as_deref()).await
}

#[tauri::command]
pub fn bigthing_runtime(goal_id: String, state: State<'_, AppState>) -> CommandResult<RuntimeView> {
    Ok(engine(&state)?.runtime(&goal_id))
}

#[tauri::command]
pub async fn bigthing_briefing(goal_id: String, state: State<'_, AppState>) -> CommandResult<String> {
    engine(&state)?.briefing_preview(&goal_id).await
}

#[tauri::command]
pub fn bigthing_commits(goal_id: String, state: State<'_, AppState>) -> CommandResult<Vec<RunCommit>> {
    engine(&state)?.run_commits(&goal_id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackRequest {
    pub goal_id: String,
    pub commit: String,
}

#[tauri::command]
pub async fn bigthing_rollback(request: RollbackRequest, state: State<'_, AppState>) -> CommandResult<()> {
    engine(&state)?.rollback(&request.goal_id, &request.commit).await
}

#[tauri::command]
pub async fn bigthing_merge(goal_id: String, state: State<'_, AppState>) -> CommandResult<MergeOutcome> {
    engine(&state)?.merge_run(&goal_id).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryListRequest {
    pub workspace_id: String,
    #[serde(default)]
    pub query: Option<String>,
}

/// The project's shared memory, for the screen.
#[tauri::command]
pub fn memory_list(request: MemoryListRequest, state: State<'_, AppState>) -> CommandResult<Vec<MemoryEntry>> {
    state.with_storage(|s| s.memory_list(&request.workspace_id, request.query.as_deref())).map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryWriteRequest {
    pub workspace_id: String,
    pub entry: MemoryWrite,
}

#[tauri::command]
pub fn memory_write(request: MemoryWriteRequest, state: State<'_, AppState>) -> CommandResult<MemoryEntry> {
    state.with_storage(|s| s.memory_write(&request.workspace_id, &request.entry, "user", None)).map_err(storage_error)
}

#[tauri::command]
pub fn memory_delete(id: String, state: State<'_, AppState>) -> CommandResult<()> {
    state.with_storage(|s| s.memory_delete(&id)).map_err(storage_error)
}
