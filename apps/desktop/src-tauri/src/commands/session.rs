//! Session lifecycle commands (spec section 8, 20.1).
//!
//! Opening requires an explicit trusted-local decision (UX-02): an agent
//! starts the project's configured MCP servers and runs its tools, so
//! launching one is executing project configuration. Submissions are recorded
//! in the durable outbox before the frame is written and never resent
//! automatically.

use std::{path::{Path, PathBuf}, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{State, ipc::Channel};
use thingmaker_supervisor::{
    DecimalId, DesktopError, SessionHandle,
    acp::{LaunchTarget, SessionId},
    delegation::Combo,
    agents::{
        PermissionStance, Provider,
        claude::launch::{CLAUDE_ORCHESTRATOR_EFFORT, CLAUDE_ORCHESTRATOR_FALLBACK, CLAUDE_ORCHESTRATOR_MODEL, ClaudeLaunchOptions},
        codex::CodexLaunchOptions,
        gemini::GeminiLaunchOptions,
        usage::TranscriptUsage,
    },
    security::EnvironmentProfile,
    storage::{
        content_hash,
        workspaces::{ArchiveState, SessionOrigin, SessionRecord, TrustState, WorkspaceRecord},
    },
    supervisor::{
        AgentLaunch, EventEnvelope, SessionActor, SessionActorConfig, Snapshot, SteerOutcome, SubmissionOutcome,
        SubmissionState,
    },
};

use super::{CommandResult, storage_error};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum OpenRequestMode {
    New,
    Resume { session_id: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub workspace_id: String,
    pub mode: OpenRequestMode,
    /// Which provider to launch. On a resume the session's own record wins:
    /// its transcript was written by that provider.
    #[serde(default)]
    pub provider: Option<Provider>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    /// The team this session starts with. `None` keeps the one it had, or
    /// the user's default.
    #[serde(default)]
    pub combo: Option<Combo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResponse {
    pub handle: SessionHandle,
    pub desktop_session_id: String,
    pub snapshot: Snapshot,
}

fn trusted_workspace(state: &AppState, workspace_id: &str) -> CommandResult<thingmaker_supervisor::storage::workspaces::WorkspaceRecord> {
    let record = state
        .with_storage(|storage| storage.workspace_get(workspace_id))
        .map_err(storage_error)?
        .ok_or_else(|| DesktopError::not_ready("workspace not found"))?;
    // Every workspace is trusted (see `workspace::ensure_trusted`).
    super::workspace::ensure_trusted(state, record)
}

/// What an agent may do without asking
/// (docs/plans/odyssey-second-orchestrator.md §2.2).
///
/// The same gate a desktop-run check passes. A trusted workspace has already
/// been agreed to be one where this machine runs the project's code, so an
/// unattended run accepting its own edits is inside that agreement; anything
/// else is not, and the run plans rather than acts.
fn permission_for(record: &WorkspaceRecord) -> PermissionStance {
    match record.trust_state {
        TrustState::TrustedLocal => PermissionStance::AcceptEdits,
        _ => PermissionStance::ReadOnly,
    }
}

/// Whether the provider has a transcript for `session_id`, which is what a
/// resume replays.
fn transcript_exists(state: &AppState, provider: Provider, root: &Path, session_id: &str) -> bool {
    let Some(home) = state.home.clone() else { return true };
    match provider {
        Provider::Claude => thingmaker_supervisor::agents::claude::transcript_usage::transcript_path(&home, root, session_id).is_file(),
        Provider::Codex => {
            let codex_home = std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".codex"));
            thingmaker_supervisor::agents::codex::transcript_usage::find_rollout(&codex_home, session_id).is_some()
        }
        Provider::Gemini => thingmaker_supervisor::agents::gemini::launch::conversation_path(&home, session_id).is_file(),
    }
}

/// A provider's launch for a session in `record`, used for the user's
/// sessions and for workers alike: the program found, the workspace's trust
/// as the permission stance, and the model and effort as given.
pub(crate) fn build_launch(
    state: &AppState,
    record: &WorkspaceRecord,
    provider: Provider,
    model: Option<String>,
    effort: Option<String>,
    resume: Option<String>,
    reserved: SessionId,
) -> CommandResult<(LaunchTarget, AgentLaunch)> {
    let root = Path::new(&record.canonical_root);
    let resolved = state.resolve_provider(provider)?;
    Ok(match provider {
        Provider::Claude => {
            let mut options = ClaudeLaunchOptions::new(root, resolved.program.clone(), resolved.prefix_args.clone());
            // The same reservation the caller vetted, so the actor's handle
            // is the id it checked for a duplicate attachment.
            options.reserved = reserved;
            options.model = model;
            options.model_fallback = Some(CLAUDE_ORCHESTRATOR_FALLBACK.to_string());
            options.effort = effort;
            options.permission_mode = permission_for(record);
            options.resume = resume;
            (LaunchTarget::executable(resolved.program), AgentLaunch::Claude(options))
        }
        Provider::Codex => {
            let mut options = CodexLaunchOptions::new(root, resolved.program.clone());
            options.reserved = reserved;
            options.model = model;
            options.effort = effort;
            options.permission_mode = permission_for(record);
            options.resume = resume;
            (LaunchTarget::executable(resolved.program), AgentLaunch::Codex(options))
        }
        Provider::Gemini => {
            let mut options = GeminiLaunchOptions::new(root, resolved.program.clone());
            options.reserved = reserved;
            options.model = model;
            options.effort = effort;
            options.permission_mode = permission_for(record);
            options.resume = resume;
            (LaunchTarget::executable(resolved.program), AgentLaunch::Gemini(options))
        }
    })
}

/// The documented environment plus the user's runtime variables.
pub(crate) fn launch_environment(state: &AppState) -> EnvironmentProfile {
    let mut environment = EnvironmentProfile::trusted_local();
    let (extra, missing) = super::runtime_env::resolve_for_launch(state);
    for (name, value) in extra {
        environment = environment.with_set(name, value);
    }
    if !missing.is_empty() {
        tracing::warn!(?missing, "runtime environment variables configured but not readable from the keychain");
    }
    environment
}

#[tauri::command]
pub async fn session_open(request: OpenRequest, state: State<'_, AppState>) -> CommandResult<OpenResponse> {
    let record = trusted_workspace(&state, &request.workspace_id)?;
    let session_id = match &request.mode {
        OpenRequestMode::New => SessionId::reserve(),
        OpenRequestMode::Resume { session_id } => SessionId::new(session_id.clone())?,
    };
    // By the handle, and by the agent's own id: a worker opened by a
    // delegation is addressed by a reserved handle, and resuming its id would
    // start a second process on a session the first one is still writing.
    let running_elsewhere = matches!(&request.mode, OpenRequestMode::Resume { session_id } if state.actor_ids().iter().any(|id| state.agent_session_id(id) == *session_id));
    if state.actor(session_id.as_str()).is_some() || running_elsewhere {
        return Err(DesktopError::conflict(
            "This session is already attached in this application. Use the existing attachment instead of starting a second agent process.",
        ));
    }
    let recorded = match &request.mode {
        OpenRequestMode::Resume { session_id } => state
            .with_storage(|storage| storage.session_by_agent_id(&record.id, session_id))
            .map_err(storage_error)?
            .map(|session| session.provider),
        OpenRequestMode::New => None,
    };
    let provider = recorded.or(request.provider).unwrap_or_default();
    // A session that never got a prompt has no transcript, so its provider
    // has nothing to resume and would answer "resource not found". Its row
    // is a tombstone: hidden, and said so plainly.
    if let OpenRequestMode::Resume { session_id } = &request.mode
        && !transcript_exists(&state, provider, Path::new(&record.canonical_root), session_id)
    {
        if let Ok(Some(row)) = state.with_storage(|storage| storage.session_by_agent_id(&record.id, session_id)) {
            let _ = state.with_storage(|storage| storage.session_set_archive(&row.id, thingmaker_supervisor::storage::workspaces::ArchiveState::Unavailable));
        }
        return Err(DesktopError::not_ready(format!(
            "This {} session never got a prompt, so there is nothing to resume; it has been removed from the list. Start a new session instead.",
            provider.label()
        )));
    }
    // The user's orchestrator settings, read once so the launch can fall back
    // to the built-in preference without the storage call happening twice.
    let settings: Option<serde_json::Value> = state
        .with_storage(|storage| storage.setting_get("notifications", thingmaker_supervisor::storage::settings::GLOBAL_SCOPE))
        .map_err(storage_error)?;
    let read_setting = |key: &str| {
        settings
            .as_ref()
            .and_then(|value| value.get(key))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .filter(|text| !text.trim().is_empty())
    };
    // An explicit request wins; then the user's setting; then the built-in
    // preference. Codex has no built-in one: the account's default stands.
    let (model, effort) = match provider {
        Provider::Claude => (
            request.model.clone().or_else(|| read_setting("claudeOrchestratorModel")).or_else(|| Some(CLAUDE_ORCHESTRATOR_MODEL.to_string())),
            request.reasoning_effort.clone().or_else(|| read_setting("claudeOrchestratorEffort")).or_else(|| Some(CLAUDE_ORCHESTRATOR_EFFORT.to_string())),
        ),
        Provider::Codex | Provider::Gemini => (request.model.clone(), request.reasoning_effort.clone()),
    };
    let resume = match &request.mode {
        OpenRequestMode::Resume { session_id } => Some(session_id.clone()),
        OpenRequestMode::New => None,
    };
    let (target, mut launch) = build_launch(&state, &record, provider, model, effort, resume, session_id.clone())?;
    let generation = 1;
    let mut config = SessionActorConfig::new(target, launch.clone());
    config.environment = launch_environment(&state);
    config.attachment_generation = generation;

    // Every session the user opens leads a team, even an empty one: workers
    // can be added while it runs.
    let row_before = match &request.mode {
        OpenRequestMode::Resume { session_id } => state.with_storage(|s| s.session_by_agent_id(&record.id, session_id)).ok().flatten().map(|row| row.id),
        OpenRequestMode::New => None,
    };
    let combo = super::delegation::starting_combo(&state, request.combo.clone(), row_before.as_deref());
    super::delegation::prepare_orchestrator(&state, session_id.as_str(), PathBuf::from(&record.canonical_root), &combo, &mut launch, &mut config);
    config.launch = launch;

    let actor = match SessionActor::open(config).await {
        Ok(actor) => actor,
        Err(error) => {
            super::delegation::release(&state, session_id.as_str()).await;
            return Err(error);
        }
    };
    let snapshot = actor.snapshot().await?;
    let handle = actor.handle().clone();
    // Recorded after the attachment, not before it: the agent names its own
    // session and only says so in the `session/new` reply, so the id the
    // desktop reserved is not the id the transcript is under.
    let recorded_id = snapshot.agent_session_id.clone().unwrap_or_else(|| session_id.as_str().to_string());
    let desktop_session = state
        .with_storage(|storage| storage.session_upsert(&record.id, &recorded_id, SessionOrigin::Desktop, provider))
        .map_err(storage_error)?;
    let _ = state.with_storage(|storage| storage.session_touch(&desktop_session.id));
    let _ = state.with_storage(|storage| storage.setting_set(super::delegation::COMBO_KEY, &super::delegation::session_scope(&desktop_session.id), &combo));
    super::delegation::watch_orchestrator(&state, &actor);
    state.insert_actor(handle.id.clone(), recorded_id.clone(), actor, PathBuf::from(&record.canonical_root));
    // Baseline before agent work (REV-02). Captured off the command path so a
    // large tree never delays the attachment; failures are logged, not fatal.
    if matches!(request.mode, OpenRequestMode::New) {
        let workspace_id = record.id.clone();
        let agent_session_id = recorded_id.clone();
        let data_dir = state.data_dir.clone();
        let root = record.canonical_root.clone();
        let storage_handle = state.inner_arc();
        tauri::async_runtime::spawn_blocking(move || {
            let blobs = thingmaker_supervisor::review::BlobStore::new(data_dir.join("blobs"));
            match thingmaker_supervisor::review::capture_baseline(Path::new(&root), &blobs) {
                Ok(manifest) => {
                    let base_ref = if thingmaker_supervisor::review::is_git_repository(Path::new(&root)) {
                        thingmaker_supervisor::review::git_head(Path::new(&root)).ok()
                    } else {
                        None
                    };
                    let session = storage_handle.with_storage(|s| s.session_by_agent_id(&workspace_id, &agent_session_id)).ok().flatten();
                    let result = storage_handle.with_storage(|s| {
                        s.baseline_insert(&workspace_id, session.as_ref().map(|s| s.id.as_str()), "session_baseline", base_ref.as_deref(), &manifest)
                    });
                    if let Err(error) = result {
                        tracing::warn!(%error, "baseline insert failed");
                    }
                }
                Err(error) => tracing::warn!(?error, "baseline capture failed"),
            }
        });
    }
    Ok(OpenResponse {
        handle,
        desktop_session_id: desktop_session.id,
        snapshot,
    })
}

fn actor_for(state: &AppState, handle: &SessionHandle) -> CommandResult<SessionActor> {
    let actor = state
        .actor(&handle.id)
        .ok_or_else(|| DesktopError::not_ready("session is not attached in this application"))?;
    if actor.handle().attachment_generation != handle.attachment_generation {
        return Err(DesktopError::conflict(
            "stale session handle: the attachment was restarted; refresh the snapshot",
        ));
    }
    Ok(actor)
}

/// Streams ordered event envelopes into a Tauri channel. The subscription
/// lives as long as the channel; dropping it never affects the actor.
#[tauri::command]
pub fn session_subscribe(
    handle: SessionHandle,
    on_event: Channel<Arc<EventEnvelope>>,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let actor = actor_for(&state, &handle)?;
    let mut subscription = actor.subscribe();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = subscription.recv().await {
            if on_event.send(event).is_err() {
                break;
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn session_snapshot(handle: SessionHandle, state: State<'_, AppState>) -> CommandResult<Snapshot> {
    let actor = actor_for(&state, &handle)?;
    actor.snapshot().await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitRequest {
    pub handle: SessionHandle,
    /// Client-generated UUID used for durable intent and double-submit
    /// protection.
    pub request_id: String,
    pub text: String,
    /// Snapshotted media ids (UX-06); gated by negotiated capabilities.
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    /// File mentions with an explicit delivery mode (UX-07).
    #[serde(default)]
    pub mentions: Vec<thingmaker_supervisor::attachments::Mention>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitResponse {
    pub request_id: String,
    pub outcome: SubmissionOutcome,
}

#[tauri::command]
pub async fn session_submit(request: SubmitRequest, state: State<'_, AppState>) -> CommandResult<SubmitResponse> {
    if request.text.trim().is_empty() && request.attachment_ids.is_empty() && request.mentions.is_empty() {
        return Err(DesktopError::io("prompt is empty"));
    }
    if request.request_id.len() > 128 || request.request_id.is_empty() {
        return Err(DesktopError::io("invalid request id"));
    }
    let actor = actor_for(&state, &request.handle)?;
    let root = state
        .actor_entries()
        .into_iter()
        .find(|(id, _)| *id == request.handle.id)
        .map(|(_, root)| root)
        .ok_or_else(|| DesktopError::not_ready("session root unknown"))?;
    // The row is under the id the *agent* knows, which for a new session is
    // not the handle. Looking it up by the handle failed every prompt to a
    // Claude session with "session record missing".
    let agent_session_id = state.agent_session_id(&request.handle.id);
    let desktop_session_id = state
        .with_storage(|storage| -> Result<Option<String>, thingmaker_supervisor::storage::StorageError> {
            for workspace in storage.workspace_list()? {
                if let Some(session) = storage.session_by_agent_id(&workspace.id, &agent_session_id)? {
                    return Ok(Some(session.id));
                }
            }
            Ok(None)
        })
        .map_err(storage_error)?
        .ok_or_else(|| DesktopError::not_ready("session record missing"))?;

    // Block order: mentions (references or copied content), then the typed
    // text, then media. Media is validated against the negotiated prompt
    // capabilities before anything is recorded.
    let mut blocks = Vec::new();
    for mention in &request.mentions {
        blocks.push(thingmaker_supervisor::attachments::mention_block(&root, mention)?);
    }
    if !request.text.trim().is_empty() {
        blocks.push(json!({ "type": "text", "text": request.text }));
    }
    if !request.attachment_ids.is_empty() {
        let capabilities = actor.snapshot().await?.capabilities;
        let (prompt_image, prompt_audio) = capabilities
            .as_ref()
            .map(|c| (c.prompt_image, c.prompt_audio))
            .unwrap_or((false, false));
        let store = thingmaker_supervisor::attachments::AttachmentStore::new(&state.data_dir);
        let mut snapshots = Vec::new();
        let mut media = Vec::new();
        for id in &request.attachment_ids {
            let (snapshot, bytes) = store.load(id)?;
            media.push(thingmaker_supervisor::attachments::media_block(&snapshot, &bytes, prompt_image, prompt_audio)?);
            snapshots.push(snapshot);
        }
        thingmaker_supervisor::attachments::check_envelope(&snapshots)?;
        blocks.extend(media);
    }
    let payload = serde_json::to_vec(&blocks).unwrap_or_default();
    let hash = content_hash(&payload);
    let payload_dir = state.data_dir.join("outbox");
    let payload_ref = format!("outbox/{}.json", request.request_id);
    std::fs::create_dir_all(&payload_dir).map_err(|e| DesktopError::io(e.to_string()))?;
    std::fs::write(payload_dir.join(format!("{}.json", request.request_id)), &payload)
        .map_err(|e| DesktopError::io(e.to_string()))?;

    let generation = DecimalId(request.handle.attachment_generation.0);
    let inserted = state.with_storage(|storage| {
        storage.outbox_insert(&request.request_id, &desktop_session_id, &hash, &payload_ref, generation)
    });
    if let Err(error) = inserted {
        // A duplicate request id means the same click was delivered twice.
        if matches!(error, thingmaker_supervisor::storage::StorageError::Sqlite(_)) {
            return Err(DesktopError::conflict(
                "this submission was already sent; check its state instead of sending again",
            ));
        }
        return Err(storage_error(error));
    }
    let _ = state.with_storage(|storage| storage.outbox_transition(&request.request_id, SubmissionState::Writing, None));
    let outcome = actor.submit(request.request_id.clone(), blocks).await?;
    let (target_state, message) = match &outcome {
        SubmissionOutcome::Accepted => (SubmissionState::Accepted, None),
        SubmissionOutcome::Rejected { error } => (SubmissionState::Rejected, Some(error.message.clone())),
        SubmissionOutcome::OutcomeUnknown { error } => (SubmissionState::OutcomeUnknown, Some(error.message.clone())),
    };
    let _ = state.with_storage(|storage| {
        storage.outbox_transition(&request.request_id, target_state, message.as_deref())
    });
    Ok(SubmitResponse {
        request_id: request.request_id,
        outcome,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteerRequest {
    pub handle: SessionHandle,
    pub text: String,
}

#[tauri::command]
pub async fn session_steer(request: SteerRequest, state: State<'_, AppState>) -> CommandResult<SteerOutcome> {
    if request.text.trim().is_empty() {
        return Err(DesktopError::io("steer text is empty"));
    }
    let actor = actor_for(&state, &request.handle)?;
    actor.steer_text(&request.text).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetConfigRequest {
    pub handle: SessionHandle,
    pub config_id: String,
    pub value: serde_json::Value,
}

/// Live configuration change through the agent's own
/// `session/set_config_option` (P08). The agent validates the value; the
/// desktop never hardcodes model ids. The result echoes the agent's updated
/// option list.
#[tauri::command]
pub async fn session_set_config_option(request: SetConfigRequest, state: State<'_, AppState>) -> CommandResult<serde_json::Value> {
    if request.config_id.is_empty() || request.config_id.len() > 128 {
        return Err(DesktopError::io("invalid config id"));
    }
    if let Some(text) = request.value.as_str()
        && text.len() > 512
    {
        return Err(DesktopError::io("config value too long"));
    }
    let actor = actor_for(&state, &request.handle)?;
    actor.set_config_option(request.config_id, request.value).await
}

#[tauri::command]
pub async fn session_cancel(handle: SessionHandle, state: State<'_, AppState>) -> CommandResult<()> {
    let actor = actor_for(&state, &handle)?;
    actor.cancel().await
}

#[tauri::command]
pub async fn session_stop(
    handle: SessionHandle,
    state: State<'_, AppState>,
) -> CommandResult<thingmaker_supervisor::transport::ExitInfo> {
    let actor = actor_for(&state, &handle)?;
    // Its workers go with it.
    super::delegation::release(&state, &handle.id).await;
    let exit = actor.stop().await;
    state.remove_actor(&handle.id);
    exit
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveRequest {
    pub workspace_id: String,
    pub agent_session_id: String,
    #[serde(default)]
    pub provider: Option<Provider>,
    pub archived: bool,
}

/// Desktop-side hide/unhide of a durable session (spec 15.1). This is an index
/// flag only: the agent's transcript is never deleted or modified (ADR-06).
#[tauri::command]
pub fn session_archive(request: ArchiveRequest, state: State<'_, AppState>) -> CommandResult<()> {
    let record = state
        .with_storage(|storage| storage.session_upsert(&request.workspace_id, &request.agent_session_id, SessionOrigin::Unknown, request.provider.unwrap_or_default()))
        .map_err(storage_error)?;
    let target = if request.archived { ArchiveState::Archived } else { ArchiveState::Active };
    state.with_storage(|storage| storage.session_set_archive(&record.id, target)).map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinRequest {
    pub workspace_id: String,
    pub agent_session_id: String,
    #[serde(default)]
    pub provider: Option<Provider>,
    pub pinned: bool,
}

/// Desktop-side pin of a durable session so it sorts above the rest. Like the
/// archive flag this is an index decision only: the agent's transcript is
/// never touched (ADR-06).
#[tauri::command]
pub fn session_pin(request: PinRequest, state: State<'_, AppState>) -> CommandResult<()> {
    let record = state
        .with_storage(|storage| storage.session_upsert(&request.workspace_id, &request.agent_session_id, SessionOrigin::Unknown, request.provider.unwrap_or_default()))
        .map_err(storage_error)?;
    state.with_storage(|storage| storage.session_set_pinned(&record.id, request.pinned)).map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameRequest {
    pub workspace_id: String,
    pub agent_session_id: String,
    #[serde(default)]
    pub provider: Option<Provider>,
    /// `None` or blank clears the overlay and restores the derived title.
    pub title: Option<String>,
}

/// Desktop-side display name for a durable session. An overlay in the desktop
/// index: the agent's transcript and session store are untouched (ADR-06).
#[tauri::command]
pub fn session_rename(request: RenameRequest, state: State<'_, AppState>) -> CommandResult<()> {
    let record = state
        .with_storage(|storage| storage.session_upsert(&request.workspace_id, &request.agent_session_id, SessionOrigin::Unknown, request.provider.unwrap_or_default()))
        .map_err(storage_error)?;
    state
        .with_storage(|storage| storage.session_set_title_overlay(&record.id, request.title.as_deref()))
        .map_err(storage_error)
}

/// Desktop records for a workspace's sessions (archive flags, origin).
#[tauri::command]
pub fn session_records(workspace_id: String, state: State<'_, AppState>) -> CommandResult<Vec<SessionRecord>> {
    state.with_storage(|storage| storage.session_list(&workspace_id)).map_err(storage_error)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionEntry {
    pub handle: SessionHandle,
    pub workspace_id: Option<String>,
    pub root: String,
    /// The id the agent knows the session by, so a resume of a session that
    /// is already running (a worker, say) attaches to it instead.
    pub agent_session_id: String,
}

/// Live attachments with their workspace, for renderer rehydration (REC-04).
#[tauri::command]
pub fn session_list_open(state: State<'_, AppState>) -> Vec<OpenSessionEntry> {
    state
        .actor_entries()
        .into_iter()
        .filter_map(|(id, root)| {
            let actor = state.actor(&id)?;
            let workspace_id = state
                .with_storage(|s| s.workspace_by_root(&root.to_string_lossy()))
                .ok()
                .flatten()
                .map(|w| w.id);
            Some(OpenSessionEntry { handle: actor.handle().clone(), workspace_id, root: root.to_string_lossy().into_owned(), agent_session_id: state.agent_session_id(&id) })
        })
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRequest {
    pub handle: SessionHandle,
    pub after: DecimalId,
    pub limit: usize,
}

/// Retained events after a sequence, for replay after resume, lag or restart.
#[tauri::command]
pub async fn session_history(request: HistoryRequest, state: State<'_, AppState>) -> CommandResult<Vec<Arc<EventEnvelope>>> {
    let actor = actor_for(&state, &request.handle)?;
    actor.history(request.after.0, request.limit.clamp(1, 20_000)).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxEntry {
    pub record: thingmaker_supervisor::storage::outbox::OutboxRecord,
    pub agent_session_id: Option<String>,
    /// Text of the prompt as stored; shown so the user can decide.
    pub text: Option<String>,
}

/// Submissions whose acceptance is unknown or that were interrupted before
/// acceptance (REC-01). Shown for explicit review; never resent automatically.
#[tauri::command]
pub fn outbox_list(workspace_id: String, state: State<'_, AppState>) -> CommandResult<Vec<OutboxEntry>> {
    let records = state.with_storage(|s| s.outbox_uncertain_for_workspace(&workspace_id)).map_err(storage_error)?;
    let sessions = state.with_storage(|s| s.session_list(&workspace_id)).map_err(storage_error)?;
    Ok(records
        .into_iter()
        .map(|record| {
            let agent_session_id = sessions.iter().find(|s| s.id == record.session_id).map(|s| s.agent_session_id.clone());
            let text = std::fs::read(state.data_dir.join(&record.payload_ref))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                .and_then(|blocks| {
                    blocks.as_array().and_then(|items| items.iter().find_map(|b| b.get("text").and_then(|t| t.as_str()).map(str::to_string)))
                });
            OutboxEntry { record, agent_session_id, text }
        })
        .collect())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxResolveRequest {
    pub request_id: String,
    /// Recorded reason, e.g. "discarded by user" or "resent as <id>".
    pub reason: String,
}

/// Closes an uncertain entry as rejected with the user's decision recorded.
#[tauri::command]
pub fn outbox_resolve(request: OutboxResolveRequest, state: State<'_, AppState>) -> CommandResult<()> {
    let current = state
        .with_storage(|s| s.outbox_get(&request.request_id))
        .map_err(storage_error)?
        .ok_or_else(|| DesktopError::not_ready("outbox entry not found"))?;
    let path = if current.state == SubmissionState::Writing {
        // A crash between writing and acceptance: mark unknown first so the
        // legal transition chain is preserved in the record.
        state.with_storage(|s| s.outbox_transition(&request.request_id, SubmissionState::OutcomeUnknown, Some("interrupted before acceptance")))
    } else {
        Ok(current)
    };
    path.map_err(storage_error)?;
    state
        .with_storage(|s| s.outbox_transition(&request.request_id, SubmissionState::Rejected, Some(&request.reason)))
        .map(|_| ())
        .map_err(storage_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageRequest {
    pub workspace_id: String,
    pub agent_session_id: String,
}

/// Per-call token counts aggregated from the agent's own canonical transcript
/// (CTX-03, docs/plans/odyssey-second-orchestrator.md §2.6). Read-only: the
/// desktop never writes the transcript.
///
/// Each provider keeps one, in its own place and shape, and each is reduced to
/// the same totals here so that everything downstream — the budget a goal is
/// charged against, the check that a prompt was actually answered, the spend
/// samples — needs to know nothing about which agent ran.
#[tauri::command]
pub fn session_token_usage(request: TokenUsageRequest, state: State<'_, AppState>) -> CommandResult<TranscriptUsage> {
    let id = SessionId::new(&request.agent_session_id).map_err(|_| DesktopError::io("invalid session id"))?;
    let record = state
        .with_storage(|s| s.workspace_get(&request.workspace_id))
        .map_err(storage_error)?
        .ok_or_else(|| DesktopError::not_ready("workspace not found"))?;
    let home = state.home.clone().ok_or_else(|| DesktopError::not_ready("HOME is not set"))?;
    let root = std::path::Path::new(&record.canonical_root);
    let provider = state
        .with_storage(|s| s.session_by_agent_id(&record.id, id.as_str()))
        .map_err(storage_error)?
        .map(|session| session.provider)
        .unwrap_or_default();
    match provider {
        Provider::Claude => {
            use thingmaker_supervisor::agents::claude::transcript_usage;
            transcript_usage::read_transcript_usage(&transcript_usage::transcript_path(&home, root, id.as_str()))
        }
        Provider::Codex => {
            use thingmaker_supervisor::agents::codex::transcript_usage;
            let codex_home = std::env::var_os("CODEX_HOME").map(std::path::PathBuf::from).unwrap_or_else(|| home.join(".codex"));
            let path = transcript_usage::find_rollout(&codex_home, id.as_str())
                .ok_or_else(|| DesktopError::not_ready("Codex has not written this thread's transcript yet"))?;
            transcript_usage::read_transcript_usage(&path)
        }
        // `agy` keeps its conversation in its own database; usage arrives on
        // the session's stream instead.
        Provider::Gemini => Err(DesktopError::unsupported("Antigravity reports token usage on the session's stream, not in a transcript the desktop reads")),
    }
}
