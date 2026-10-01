//! The session actor: one task owning one agent attachment.
//!
//! The actor is the single owner of the transport, the reducer, the tool-call
//! projection and the event sequence. Requests to the agent run as spawned
//! tasks so the loop never stops draining incoming traffic; their results
//! re-enter the loop as internal messages and are applied in order. Text
//! chunks are coalesced at about 30 Hz and flushed before every non-text
//! transition, command reply and shutdown (F02).
//!
//! Bootstrap: `initialize` -> `session/new` | `session/load` (which replays
//! the session as updates before it answers). Replay updates are published
//! while the load request is pending, so history is visible before the
//! attachment is reported `Attached`.
//!
//! Every provider is ACP here. `session/prompt` answers when the turn is
//! over, with its `stopReason`; the prompt reaching the agent's input is the
//! acceptance.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::{
    sync::{broadcast, mpsc, oneshot},
    time::{self, Instant},
};

use super::{
    events::{EventEnvelope, EventSubscription, SessionEvent, SteerState},
    state::{
        AttachmentState, DetachedCallState, ProcessState, SessionReducer, SubmissionState,
        TurnEffect, TurnInput, TurnPhase,
    },
};
use crate::{
    acp::{
        ClientIdentity,
        capabilities::{self, CapabilitySnapshot},
        errors,
        launch::{self, LaunchTarget},
        updates::{AvailableCommand, ContentBlock, MessageUpdate, SessionUpdate, ToolPatch, cap_chars, decode_update},
    },
    agents::{AgentLaunch, Provider, claude, codex},
    error::{DesktopError, ErrorCode},
    ids::{DecimalId, SessionHandle},
    security::EnvironmentProfile,
    transport::{ExitInfo, Incoming, RequestId, TransportError, jsonrpc, limits},
};

use super::connection::Connection;

/// Envelopes retained per actor for history replay. Beyond this the oldest
/// are dropped and `Snapshot::history_dropped` reports the gap.
pub const HISTORY_LIMIT: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timeouts {
    pub control: Duration,
    pub resume_inactivity: Duration,
    /// Ceiling on one turn (`session/prompt`) and on a `session/load`
    /// replay. Progress inside a replay is policed separately by
    /// `resume_inactivity`.
    pub turn: Duration,
    /// A running turn with nothing happening for this long is cancelled; a
    /// tool call in flight counts as something happening.
    pub turn_inactivity: Duration,
    pub shutdown: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            control: limits::CONTROL_REQUEST_TIMEOUT,
            resume_inactivity: limits::RESUME_INACTIVITY_TIMEOUT,
            turn: limits::TURN_TIMEOUT,
            turn_inactivity: limits::TURN_INACTIVITY_TIMEOUT,
            shutdown: limits::SHUTDOWN_BUDGET,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SessionActorConfig {
    pub target: LaunchTarget,
    pub launch: AgentLaunch,
    pub environment: EnvironmentProfile,
    pub client: ClientIdentity,
    pub timeouts: Timeouts,
    pub attachment_generation: u64,
    pub event_capacity: usize,
    /// ACP `mcpServers` for `session/new` and `session/load`: the session's
    /// own servers (the ThingMaker one, for an orchestrator), never the user's
    /// configuration files.
    pub mcp_servers: Vec<Value>,
}

impl SessionActorConfig {
    /// Resuming or starting fresh is the launch's to say
    /// ([`AgentLaunch::is_resume`]): a resume is `session/load` with the id
    /// the agent gave out, and that id is already on the options.
    pub fn new(target: LaunchTarget, launch: AgentLaunch) -> Self {
        Self {
            target,
            launch,
            environment: EnvironmentProfile::trusted_local(),
            client: ClientIdentity::default(),
            timeouts: Timeouts::default(),
            attachment_generation: 1,
            event_capacity: 4096,
            mcp_servers: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum SubmissionOutcome {
    Accepted,
    Rejected { error: DesktopError },
    OutcomeUnknown { error: DesktopError },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum SteerOutcome {
    Accepted { message_id: String },
    Rejected { error: DesktopError },
    OutcomeUnknown { error: DesktopError },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub handle: SessionHandle,
    /// Which provider this attachment runs on. The renderer reads it to know
    /// which account a turn is charged to and which transcript to look in.
    pub provider: Provider,
    /// The agent's own id for the session, once `session/new` has answered.
    pub agent_session_id: Option<String>,
    pub process: ProcessState,
    pub attachment: AttachmentState,
    pub capabilities: Option<CapabilitySnapshot>,
    pub foreground: TurnPhase,
    pub autonomous_turns: Vec<i64>,
    pub detached_calls: BTreeMap<String, DetachedCallState>,
    pub tool_calls: BTreeMap<String, ToolPatch>,
    pub config_options: Value,
    pub available_commands: Vec<AvailableCommand>,
    pub pending_steers: Vec<String>,
    pub last_sequence: DecimalId,
    /// Sequence of the oldest retained event; events before it are gone.
    pub history_start: DecimalId,
    pub history_dropped: u64,
    pub exit: Option<ExitInfo>,
}

type Reply<T> = oneshot::Sender<Result<T, DesktopError>>;

enum Command {
    Submit {
        request_id: String,
        blocks: Vec<Value>,
        reply: Reply<SubmissionOutcome>,
    },
    Steer {
        blocks: Vec<Value>,
        reply: Reply<SteerOutcome>,
    },
    Cancel {
        reply: Reply<()>,
    },
    SetConfigOption {
        config_id: String,
        value: Value,
        reply: Reply<Value>,
    },
    Snapshot {
        reply: oneshot::Sender<Snapshot>,
    },
    History {
        after: u64,
        limit: usize,
        reply: oneshot::Sender<Vec<Arc<EventEnvelope>>>,
    },
    Stop {
        reply: Reply<ExitInfo>,
    },
}

enum Internal {
    InitializeResult(Result<Value, TransportError>),
    AttachResult(Result<Value, TransportError>),
    PromptWritten {
        request_id: String,
    },
    PromptResult {
        request_id: String,
        result: Result<Value, TransportError>,
    },
    SteerResult {
        message_id: String,
        result: Result<Value, TransportError>,
        reply: Reply<SteerOutcome>,
    },
    SetConfigResult {
        result: Result<Value, TransportError>,
        reply: Reply<Value>,
    },
    Stopped {
        exit: ExitInfo,
        reply: Reply<ExitInfo>,
    },
}

/// Handle to a running session actor. Cloning shares the same actor.
#[derive(Clone)]
pub struct SessionActor {
    handle: SessionHandle,
    commands: mpsc::Sender<Command>,
    events: broadcast::Sender<Arc<EventEnvelope>>,
}

impl std::fmt::Debug for SessionActor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionActor").field("handle", &self.handle).finish()
    }
}

impl SessionActor {
    /// Launches the agent, negotiates ACP and attaches the session. Returns
    /// only after the attachment is ready or has failed with a typed error.
    pub async fn open(config: SessionActorConfig) -> Result<SessionActor, DesktopError> {
        let launch = config.launch.clone();
        let session_id = launch.session_id();
        let mut environment = config.environment.clone();
        for (name, value) in launch.environment() {
            environment = environment.with_set(name, value);
        }
        let spec = launch::launch_spec(&config.target, launch.arguments(), launch.root(), &environment, std::env::vars());
        let generation = config.attachment_generation;
        let (transport, incoming) = Connection::spawn(&launch, spec, generation)
            .await
            .map_err(errors::map_transport_error)?;
        let handle = SessionHandle {
            id: session_id.clone(),
            attachment_generation: DecimalId(generation),
        };
        let (events_tx, _) = broadcast::channel(config.event_capacity.max(16));
        let (commands_tx, commands_rx) = mpsc::channel(64);
        let (internal_tx, internal_rx) = mpsc::channel(256);
        let (ready_tx, ready_rx) = oneshot::channel();

        let state = ActorState {
            handle: handle.clone(),
            config: config.clone(),
            launch,
            transport,
            events: events_tx.clone(),
            internal: internal_tx,
            sequence: DecimalId(0),
            process: ProcessState::Starting,
            attachment: AttachmentState::New,
            capabilities: None,
            reducer: SessionReducer::new(generation),
            expected_session_id: session_id,
            agent_session_id: None,
            tool_calls: BTreeMap::new(),
            detached: BTreeMap::new(),
            config_options: Value::Array(Vec::new()),
            available_commands: Vec::new(),
            pending_steers: BTreeSet::new(),
            open_tools: BTreeSet::new(),
            submitted_prompts: BTreeMap::new(),
            echo: None,
            message_run: None,
            message_serial: 0,
            pending_submits: BTreeMap::new(),
            pending_chunk: None,
            chunk_deadline: None,
            last_progress: Instant::now(),
            history: std::collections::VecDeque::new(),
            history_dropped: 0,
            ready: Some(ready_tx),
            exit: None,
            exited_emitted: false,
            stopping: false,
        };
        tokio::spawn(run_loop(state, commands_rx, incoming, internal_rx));

        match ready_rx.await {
            Ok(Ok(())) => Ok(SessionActor {
                handle,
                commands: commands_tx,
                events: events_tx,
            }),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(DesktopError::not_ready("session actor stopped during startup")),
        }
    }

    pub fn handle(&self) -> &SessionHandle {
        &self.handle
    }

    pub fn subscribe(&self) -> EventSubscription {
        EventSubscription::new(self.events.subscribe(), self.handle.clone())
    }

    async fn send<T>(&self, build: impl FnOnce(Reply<T>) -> Command) -> Result<T, DesktopError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.commands
            .send(build(reply_tx))
            .await
            .map_err(|_| DesktopError::not_ready("session actor has stopped"))?;
        reply_rx
            .await
            .map_err(|_| DesktopError::not_ready("session actor dropped the reply"))?
    }

    /// Submits a new prompt. Resolves at acceptance, rejection or uncertainty;
    /// completion arrives later as `Turn` events.
    pub async fn submit(
        &self,
        request_id: impl Into<String>,
        blocks: Vec<Value>,
    ) -> Result<SubmissionOutcome, DesktopError> {
        let request_id = request_id.into();
        self.send(|reply| Command::Submit {
            request_id,
            blocks,
            reply,
        })
        .await
    }

    pub async fn submit_text(
        &self,
        request_id: impl Into<String>,
        text: &str,
    ) -> Result<SubmissionOutcome, DesktopError> {
        self.submit(request_id, vec![json!({ "type": "text", "text": text })])
            .await
    }

    /// Steers the current turn: the input is injected into the turn that is
    /// running rather than queued as the next one ([`capabilities::STEER_METHOD`]).
    pub async fn steer(&self, blocks: Vec<Value>) -> Result<SteerOutcome, DesktopError> {
        self.send(|reply| Command::Steer { blocks, reply }).await
    }

    pub async fn steer_text(&self, text: &str) -> Result<SteerOutcome, DesktopError> {
        self.steer(vec![json!({ "type": "text", "text": text })]).await
    }

    pub async fn cancel(&self) -> Result<(), DesktopError> {
        self.send(|reply| Command::Cancel { reply }).await
    }

    pub async fn set_config_option(
        &self,
        config_id: impl Into<String>,
        value: Value,
    ) -> Result<Value, DesktopError> {
        let config_id = config_id.into();
        self.send(|reply| Command::SetConfigOption {
            config_id,
            value,
            reply,
        })
        .await
    }

    /// Events with sequence greater than `after`, oldest first, from the
    /// actor's bounded in-memory history. Used to rebuild a projection after
    /// resume replay, a lagging subscription or a renderer restart (REC-04).
    pub async fn history(&self, after: u64, limit: usize) -> Result<Vec<Arc<EventEnvelope>>, DesktopError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.commands
            .send(Command::History { after, limit, reply: reply_tx })
            .await
            .map_err(|_| DesktopError::not_ready("session actor has stopped"))?;
        reply_rx
            .await
            .map_err(|_| DesktopError::not_ready("session actor dropped the history reply"))
    }

    pub async fn snapshot(&self) -> Result<Snapshot, DesktopError> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.commands
            .send(Command::Snapshot { reply: reply_tx })
            .await
            .map_err(|_| DesktopError::not_ready("session actor has stopped"))?;
        reply_rx
            .await
            .map_err(|_| DesktopError::not_ready("session actor dropped the snapshot"))
    }

    /// Cancels active work, closes the session and terminates the agent
    /// within the shutdown budget.
    pub async fn stop(&self) -> Result<ExitInfo, DesktopError> {
        self.send(|reply| Command::Stop { reply }).await
    }
}

struct ActorState {
    handle: SessionHandle,
    config: SessionActorConfig,
    launch: AgentLaunch,
    transport: Connection,
    events: broadcast::Sender<Arc<EventEnvelope>>,
    internal: mpsc::Sender<Internal>,
    sequence: DecimalId,
    process: ProcessState,
    attachment: AttachmentState,
    capabilities: Option<CapabilitySnapshot>,
    reducer: SessionReducer,
    expected_session_id: String,
    agent_session_id: Option<String>,
    tool_calls: BTreeMap<String, ToolPatch>,
    detached: BTreeMap<String, DetachedCallState>,
    config_options: Value,
    available_commands: Vec<AvailableCommand>,
    pending_steers: BTreeSet<String>,
    /// Tool calls of the running turn that have started and not ended.
    open_tools: BTreeSet<String>,
    /// Prompts submitted and not yet written, by request id: what the
    /// transcript shows as the user's message once the agent has it.
    submitted_prompts: BTreeMap<String, Vec<Value>>,
    /// The agent's own echo of the last prompt, which the transcript already
    /// shows (see [`EchoFilter`]).
    echo: Option<EchoFilter>,
    /// The role of the message the agent is streaming without an id of its
    /// own, and the id it was given. Any other update ends the run, so text
    /// either side of a tool call becomes two messages, as it reads.
    message_run: Option<(&'static str, String)>,
    message_serial: u64,
    /// Callers waiting on a submission, by request id. Answered when the
    /// prompt reaches the agent's input, or with the failure if it never
    /// does.
    pending_submits: BTreeMap<String, Reply<SubmissionOutcome>>,
    pending_chunk: Option<SessionUpdate>,
    chunk_deadline: Option<Instant>,
    last_progress: Instant,
    /// Bounded history of emitted envelopes (oldest dropped first).
    history: std::collections::VecDeque<Arc<EventEnvelope>>,
    history_dropped: u64,
    ready: Option<oneshot::Sender<Result<(), DesktopError>>>,
    exit: Option<ExitInfo>,
    exited_emitted: bool,
    stopping: bool,
}

impl ActorState {
    fn emit(&mut self, payload: SessionEvent) {
        self.sequence = self.sequence.next();
        let envelope = Arc::new(EventEnvelope::new(self.handle.clone(), self.sequence, payload));
        self.history.push_back(Arc::clone(&envelope));
        while self.history.len() > HISTORY_LIMIT {
            self.history.pop_front();
            self.history_dropped += 1;
        }
        let _ = self.events.send(envelope);
    }

    fn set_process(&mut self, state: ProcessState) {
        if self.process != state {
            self.process = state;
            let pid = self.transport.pid();
            self.emit(SessionEvent::Process { state, pid });
        }
    }

    fn set_attachment(&mut self, state: AttachmentState) {
        if self.attachment != state {
            self.attachment = state;
            let agent_session_id = self.agent_session_id.clone();
            self.emit(SessionEvent::Attachment {
                state,
                agent_session_id,
            });
        }
    }

    fn generation(&self) -> u64 {
        self.handle.attachment_generation.0
    }

    fn flush_chunk(&mut self) {
        self.chunk_deadline = None;
        if let Some(update) = self.pending_chunk.take() {
            self.emit_update(update);
        }
    }

    fn emit_update(&mut self, update: SessionUpdate) {
        let limited = update.limited(limits::PAYLOAD_LIMIT_BYTES, limits::PAYLOAD_PREVIEW_BYTES);
        self.emit(SessionEvent::Update(limited));
    }

    fn enqueue_update(&mut self, update: SessionUpdate) {
        if let (Some(key), Some(text)) = (update.coalescing_key(), update.text_chunk()) {
            let text = text.to_string();
            if let Some(pending) = &self.pending_chunk
                && pending.coalescing_key().as_deref() == Some(key.as_str())
                && let Some(previous) = pending.text_chunk()
            {
                let merged = format!("{previous}{text}");
                self.pending_chunk = Some(pending.replacing_text(merged));
            } else {
                self.flush_chunk();
                self.pending_chunk = Some(update);
            }
            if self.chunk_deadline.is_none() {
                self.chunk_deadline = Some(Instant::now() + limits::TEXT_COALESCE_INTERVAL);
            }
        } else {
            self.flush_chunk();
            self.emit_update(update);
        }
    }

    fn apply_turn(&mut self, input: TurnInput<'_>) {
        let generation = self.generation();
        let effects = self.reducer.apply(generation, input);
        for effect in effects {
            if matches!(effect, TurnEffect::Ignored { .. }) {
                tracing::debug!(?effect, "turn input ignored");
                continue;
            }
            self.emit(SessionEvent::Turn(effect));
        }
    }

    fn set_detached(&mut self, call_id: &str, state: DetachedCallState) {
        let changed = self.detached.get(call_id) != Some(&state);
        self.detached.insert(call_id.to_string(), state);
        if changed {
            self.emit(SessionEvent::DetachedCall {
                call_id: call_id.to_string(),
                state,
            });
        }
    }

    fn handle_update(&mut self, update: SessionUpdate) {
        self.last_progress = Instant::now();
        match &update {
            SessionUpdate::ToolCall(patch) | SessionUpdate::ToolCallUpdate(patch) => {
                if let Some(id) = patch.tool_call_id.clone() {
                    let merged = match self.tool_calls.get(&id) {
                        Some(existing) => existing.merging(patch),
                        None => patch.clone(),
                    };
                    let background = merged.is_background();
                    let status = merged.status.clone();
                    match status.as_deref() {
                        Some("pending") | Some("in_progress") | None if !background => {
                            self.open_tools.insert(id.clone());
                        }
                        _ => {
                            self.open_tools.remove(&id);
                        }
                    }
                    // Subagents are tool calls on this same stream — Claude
                    // Code's `Agent`/`Task`, Codex's `spawnAgent` collab call.
                    // They are translated into the event the projection, the
                    // run monitor and the task owner column already read, so
                    // none of those needs to know which agent it is watching.
                    let model = self.selected_model();
                    let event = match self.launch.provider() {
                        Provider::Claude => claude::subagents::subagent_event(&merged, model.as_deref(), now_unix_ms()),
                        Provider::Codex => codex::subagents::subagent_event(&merged, model.as_deref(), now_unix_ms()),
                        Provider::Gemini => None,
                    };
                    if let Some(event) = event {
                        self.emit(SessionEvent::RuntimeEvent(event));
                    }
                    self.tool_calls.insert(id.clone(), merged);
                    if background {
                        let state = match status.as_deref() {
                            Some("completed") => DetachedCallState::Completed,
                            Some("failed") => DetachedCallState::Failed,
                            _ => match self.detached.get(&id) {
                                Some(DetachedCallState::CancellationRequested) => {
                                    DetachedCallState::CancellationRequested
                                }
                                _ => DetachedCallState::Active,
                            },
                        };
                        self.set_detached(&id, state);
                    } else if self.detached.contains_key(&id) {
                        // A cleared background flag means the call is no
                        // longer detached; keep its last known state.
                        self.detached.remove(&id);
                    }
                }
            }
            SessionUpdate::State(state) => {
                self.flush_chunk();
                let stop_reason = state.stop_reason.clone();
                let state_name = state.state.clone();
                self.apply_turn(TurnInput::StateUpdate {
                    state: &state_name,
                    stop_reason: stop_reason.as_deref(),
                });
            }
            SessionUpdate::ConfigOptions { config_options } => {
                self.config_options = config_options.clone();
            }
            SessionUpdate::AvailableCommands { commands } => {
                self.available_commands = commands.clone();
            }
            SessionUpdate::Usage(usage) => {
                let quota = usage.meta.as_ref().and_then(|meta| {
                    meta.get(codex::bridge::QUOTA_META_KEY)
                        .and_then(|quota| serde_json::from_value(quota.clone()).ok())
                        .or_else(|| claude::quota_from_usage_meta(meta, now_unix_ms()))
                });
                if let Some(quota) = quota {
                    self.emit(SessionEvent::Quota(quota));
                }
            }
            _ => {}
        }
        if let SessionUpdate::UserMessage(message) = &update
            && message.replace
            && self.pending_steers.remove(&message.message_id)
        {
            self.flush_chunk();
            self.emit(SessionEvent::Steer {
                message_id: message.message_id.clone(),
                state: SteerState::Delivered,
            });
        }
        self.enqueue_update(update);
    }

    async fn handle_incoming(&mut self, incoming: Incoming) {
        match incoming {
            Incoming::Notification { method, params } => match method.as_str() {
                "session/update" => {
                    let Some(params) = params else {
                        self.emit(SessionEvent::Diagnostic {
                            text: "Ignored session/update without params".into(),
                        });
                        return;
                    };
                    let routed = params.get("sessionId").and_then(Value::as_str);
                    if routed != Some(self.expected_session_id.as_str()) {
                        self.emit(SessionEvent::Diagnostic {
                            text: "Ignored ACP update for another session".into(),
                        });
                        return;
                    }
                    match params.get("update").map(decode_update) {
                        Some(Ok(update)) => {
                            if let SessionUpdate::UserMessage(message) = &update
                                && self.attachment != AttachmentState::Replaying
                                && self.echo.as_mut().is_some_and(|echo| echo.swallows(message))
                            {
                                return;
                            }
                            let update = self.name_message(update);
                            self.handle_update(update)
                        }
                        Some(Err(error)) => self.emit(SessionEvent::Diagnostic {
                            text: format!("Ignored malformed desktop update: {error}"),
                        }),
                        None => self.emit(SessionEvent::Diagnostic {
                            text: "Ignored session/update without update".into(),
                        }),
                    }
                }
                "$/cancel_request" | "$/cancelRequest" => {}
                other => self.emit(SessionEvent::Diagnostic {
                    text: format!("Ignored unsupported notification {other}"),
                }),
            },
            Incoming::Request { id, method, params } => match method.as_str() {
                "session/request_permission" => {
                    self.flush_chunk();
                    let title = params
                        .as_ref()
                        .and_then(|p| p.get("title"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    // An agent runs unattended for hours, so a request nobody
                    // answers would end it at its first edit. The stance is
                    // decided once, from the workspace's trust state, and
                    // every decision taken under it is journalled by the
                    // caller that reads these events (§2.2).
                    let (outcome, decision) = match self.launch.permission() {
                        permission if !permission.allows() => (json!({ "outcome": "cancelled" }), "cancelled"),
                        _ => match allow_option(params.as_ref()) {
                            // The adapter names its own options; picking the
                            // first allowing one is the only honest way to
                            // say yes to a menu we did not write.
                            Some(option) => (json!({ "outcome": "selected", "optionId": option }), "allowed"),
                            None => (json!({ "outcome": "cancelled" }), "cancelled"),
                        },
                    };
                    self.emit(SessionEvent::PermissionRequest {
                        request_id: request_id_string(&id),
                        title,
                        decision,
                    });
                    let _ = self.transport.respond(&id, json!({ "outcome": outcome })).await;
                }
                other => {
                    self.emit(SessionEvent::Diagnostic {
                        text: format!("Rejected unsupported client request {other}"),
                    });
                    let _ = self
                        .transport
                        .respond_error(&id, jsonrpc::METHOD_NOT_FOUND, "Client method not supported")
                        .await;
                }
            },
            Incoming::StderrLine(bytes) => {
                self.last_progress = Instant::now();
                let text = String::from_utf8_lossy(&bytes);
                self.emit(SessionEvent::Diagnostic {
                    text: cap_chars(&text, limits::DIAGNOSTIC_LINE_CAP_BYTES),
                });
            }
            Incoming::StderrOverflow { bytes, limit } => self.emit(SessionEvent::Overflow {
                stream: "stderr",
                bytes,
                limit,
                fatal: false,
            }),
            Incoming::StdoutOverflow { bytes, limit } => {
                self.flush_chunk();
                self.emit(SessionEvent::Overflow {
                    stream: "stdout",
                    bytes,
                    limit,
                    fatal: true,
                });
                self.set_process(ProcessState::Degraded);
                self.set_attachment(AttachmentState::Detached);
            }
            Incoming::Protocol(error) => {
                self.emit(SessionEvent::Diagnostic {
                    text: format!("Protocol error on stdout: {error}"),
                });
                self.set_process(ProcessState::Degraded);
            }
            Incoming::LateResponse { id } => self.emit(SessionEvent::Diagnostic {
                text: format!("Late response for request {} was discarded", request_id_string(&id)),
            }),
            Incoming::Exited(info) => self.handle_exit(info),
        }
    }

    fn handle_exit(&mut self, info: ExitInfo) {
        self.flush_chunk();
        self.exit = Some(info.clone());
        self.set_process(ProcessState::Exited);
        self.apply_turn(TurnInput::TransportLost);
        let active: Vec<String> = self
            .detached
            .iter()
            .filter(|(_, state)| {
                matches!(
                    state,
                    DetachedCallState::Active | DetachedCallState::CancellationRequested
                )
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in active {
            self.set_detached(&id, DetachedCallState::Unknown);
        }
        let steers: Vec<String> = std::mem::take(&mut self.pending_steers).into_iter().collect();
        for message_id in steers {
            self.emit(SessionEvent::Steer {
                message_id,
                state: SteerState::OutcomeUnknown,
            });
        }
        self.set_attachment(AttachmentState::Detached);
        if !self.exited_emitted {
            self.exited_emitted = true;
            self.emit(SessionEvent::Exited(info));
        }
        if let Some(ready) = self.ready.take() {
            let _ = ready.send(Err(DesktopError::io(format!(
                "{} exited during startup (status {:?}, signal {:?})",
                self.launch.provider().label(),
                self.exit.as_ref().and_then(|e| e.status),
                self.exit.as_ref().and_then(|e| e.signal)
            ))));
        }
    }

    /// The model the session is on right now, from its own advertised config.
    ///
    /// Read from `configOptions` rather than from the launch options: the
    /// user can change it from the session's own controls, and a subagent row
    /// that names the model the desktop asked for rather than the one that
    /// ran is evidence of nothing.
    fn selected_model(&self) -> Option<String> {
        self.current_config_value("model")
            .or_else(|| self.launch.deferred_model().map(str::to_string))
    }

    /// Selects the model and permission mode for an agent that takes them as
    /// config options (§2.1, §2.2).
    ///
    /// Awaited rather than fired and forgotten: a session that starts working
    /// before its permission mode lands would ask for permission on its first
    /// edit, and the answer at that point is whatever the default stance is,
    /// not the one the workspace's trust decided.
    async fn apply_session_config(&mut self) {
        let session_id = self.expected_session_id.clone();
        let timeout = self.config.timeouts.control;
        // The model is tried with a fallback because the preferred one can be
        // separately exhausted: Fable is billed against usage credits rather
        // than the subscription, so it runs out on its own schedule while the
        // account is otherwise fine. Landing on the fallback is a working run
        // on a cheaper model; refusing to land is no run at all.
        if let Some(model) = self.launch.deferred_model().map(str::to_string) {
            let fallback = self.launch.deferred_model_fallback().map(str::to_string);
            if !self.select_config_option("model", &model, timeout, &session_id).await
                && let Some(fallback) = fallback
                && fallback != model
            {
                self.emit(SessionEvent::Diagnostic {
                    text: format!("{model} could not be selected; falling back to {fallback}"),
                });
                self.select_config_option("model", &fallback, timeout, &session_id).await;
            }
        }
        let mut wanted: Vec<(&'static str, String)> = Vec::new();
        if let Some(effort) = self.launch.deferred_effort() {
            wanted.push(("effort", effort.to_string()));
        }
        wanted.push(("mode", self.launch.permission_mode_id().to_string()));
        for (id, value) in wanted {
            let params = match errors::set_config_option_params(&session_id, id, &Value::String(value.clone())) {
                Ok(params) => params,
                Err(error) => {
                    self.emit(SessionEvent::Diagnostic { text: format!("Could not build the {id} option: {}", error.message) });
                    continue;
                }
            };
            match self.transport.request("session/set_config_option", params, timeout).await {
                Ok(result) => {
                    if let Some(options) = result.get("configOptions") {
                        self.config_options = options.clone();
                        self.emit(SessionEvent::Update(SessionUpdate::ConfigOptions { config_options: options.clone() }));
                    }
                }
                // Not fatal: an agent that will not take the option still
                // runs, and saying so is better than a session that silently
                // is not on the model or the stance the record claims.
                Err(error) => self.emit(SessionEvent::Diagnostic {
                    text: format!("The agent refused to set {id} to {value}: {}", errors::map_transport_error(error).message),
                }),
            }
        }
    }

    /// Sets one config option and reports whether the agent actually took it.
    ///
    /// "Took it" means the option's `currentValue` came back as what was
    /// asked for. An agent that answers the call but quietly leaves the
    /// option where it was has not taken it, and treating that as success is
    /// how a run ends up on a model the record claims it is not on.
    async fn select_config_option(&mut self, id: &str, value: &str, timeout: Duration, session_id: &str) -> bool {
        let params = match errors::set_config_option_params(session_id, id, &Value::String(value.to_string())) {
            Ok(params) => params,
            Err(error) => {
                self.emit(SessionEvent::Diagnostic { text: format!("Could not build the {id} option: {}", error.message) });
                return false;
            }
        };
        match self.transport.request("session/set_config_option", params, timeout).await {
            Ok(result) => {
                if let Some(options) = result.get("configOptions") {
                    self.config_options = options.clone();
                    self.emit(SessionEvent::Update(SessionUpdate::ConfigOptions { config_options: options.clone() }));
                }
                let taken = self.current_config_value(id).as_deref() == Some(value);
                if !taken {
                    self.emit(SessionEvent::Diagnostic {
                        text: format!("The agent did not take {id} = {value} (it is on {})", self.current_config_value(id).unwrap_or_else(|| "something else".into())),
                    });
                }
                taken
            }
            Err(error) => {
                self.emit(SessionEvent::Diagnostic {
                    text: format!("The agent refused to set {id} to {value}: {}", errors::map_transport_error(error).message),
                });
                false
            }
        }
    }

    /// The current value of one advertised config option.
    fn current_config_value(&self, id: &str) -> Option<String> {
        self.config_options
            .as_array()?
            .iter()
            .find(|option| option.get("id").and_then(Value::as_str) == Some(id))
            .and_then(|option| option.get("currentValue"))
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    fn require_ready(&self) -> Result<String, DesktopError> {
        if self.process == ProcessState::Exited {
            return Err(DesktopError::not_ready("The agent process has exited; reopen the session"));
        }
        if self.stopping || self.process == ProcessState::Closing {
            return Err(DesktopError::cancelled("session is stopping"));
        }
        if self.attachment != AttachmentState::Attached {
            return Err(DesktopError::not_ready(format!(
                "session is not attached (state: {:?})",
                self.attachment
            )));
        }
        Ok(self.expected_session_id.clone())
    }

    fn spawn_request(
        &self,
        method: &'static str,
        params: Value,
        timeout: Duration,
        written: Option<oneshot::Sender<()>>,
        wrap: impl FnOnce(Result<Value, TransportError>) -> Internal + Send + 'static,
    ) {
        let transport = self.transport.clone();
        let internal = self.internal.clone();
        tokio::spawn(async move {
            let result = transport
                .request_observed(method, params, timeout, written)
                .await;
            let _ = internal.send(wrap(result)).await;
        });
    }

    async fn handle_command(&mut self, command: Command) -> bool {
        match command {
            Command::Submit {
                request_id,
                blocks,
                reply,
            } => {
                let session_id = match self.require_ready() {
                    Ok(id) => id,
                    Err(error) => {
                        let _ = reply.send(Err(error));
                        return true;
                    }
                };
                self.flush_chunk();
                self.submitted_prompts.insert(request_id.clone(), blocks.clone());
                self.emit(SessionEvent::Submission {
                    request_id: request_id.clone(),
                    state: SubmissionState::Queued,
                    message: None,
                });
                let (written_tx, written_rx) = oneshot::channel();
                let internal = self.internal.clone();
                let written_id = request_id.clone();
                tokio::spawn(async move {
                    if written_rx.await.is_ok() {
                        let _ = internal
                            .send(Internal::PromptWritten {
                                request_id: written_id,
                            })
                            .await;
                    }
                });
                // `session/prompt` answers with the finished turn, so it
                // cannot be held to an acceptance deadline: the answer is
                // minutes away by design. The prompt reaching the agent's
                // input is the acceptance (`PromptWritten`), and the request
                // itself gets a turn-length ceiling.
                let timeout = self.config.timeouts.turn;
                self.pending_submits.insert(request_id.clone(), reply);
                self.spawn_request(
                    "session/prompt",
                    json!({ "sessionId": session_id, "prompt": blocks }),
                    timeout,
                    Some(written_tx),
                    move |result| Internal::PromptResult { request_id, result },
                );
            }
            Command::Steer { blocks, reply } => {
                let session_id = match self.require_ready() {
                    Ok(id) => id,
                    Err(error) => {
                        let _ = reply.send(Err(error));
                        return true;
                    }
                };
                let supported = self
                    .capabilities
                    .as_ref()
                    .is_some_and(|caps| caps.supports_steering);
                if !supported {
                    let _ = reply.send(Err(DesktopError::unsupported(
                        "This agent does not advertise steering a running turn. Queue the input for the next turn or cancel and send instead.",
                    )));
                    return true;
                }
                self.flush_chunk();
                // The steering request answers with nothing to name the
                // input by, so the desktop names it and tracks that.
                let message_id = format!("steer-{}", uuid::Uuid::new_v4().simple());
                self.pending_steers.insert(message_id.clone());
                self.emit(SessionEvent::Steer {
                    message_id: message_id.clone(),
                    state: SteerState::Pending,
                });
                let timeout = self.config.timeouts.control;
                self.spawn_request(
                    capabilities::STEER_METHOD,
                    json!({ "sessionId": session_id, "prompt": blocks }),
                    timeout,
                    None,
                    move |result| Internal::SteerResult { message_id, result, reply },
                );
            }
            Command::Cancel { reply } => {
                let session_id = match self.require_ready() {
                    Ok(id) => id,
                    Err(error) => {
                        let _ = reply.send(Err(error));
                        return true;
                    }
                };
                self.flush_chunk();
                self.apply_turn(TurnInput::CancelRequested);
                let result = self
                    .transport
                    .notify("session/cancel", json!({ "sessionId": session_id }))
                    .await
                    .map_err(errors::map_transport_error);
                let _ = reply.send(result);
            }
            Command::SetConfigOption {
                config_id,
                value,
                reply,
            } => {
                let session_id = match self.require_ready() {
                    Ok(id) => id,
                    Err(error) => {
                        let _ = reply.send(Err(error));
                        return true;
                    }
                };
                let params = match errors::set_config_option_params(&session_id, &config_id, &value) {
                    Ok(params) => params,
                    Err(error) => {
                        let _ = reply.send(Err(error));
                        return true;
                    }
                };
                let timeout = self.config.timeouts.control;
                self.spawn_request(
                    "session/set_config_option",
                    params,
                    timeout,
                    None,
                    move |result| Internal::SetConfigResult { result, reply },
                );
            }
            Command::Snapshot { reply } => {
                let _ = reply.send(self.snapshot());
            }
            Command::History { after, limit, reply } => {
                let events: Vec<Arc<EventEnvelope>> = self
                    .history
                    .iter()
                    .filter(|e| e.sequence.0 > after)
                    .take(limit.clamp(1, HISTORY_LIMIT))
                    .cloned()
                    .collect();
                let _ = reply.send(events);
            }
            Command::Stop { reply } => {
                if self.stopping {
                    let _ = reply.send(Err(DesktopError::cancelled("stop already in progress")));
                    return true;
                }
                self.stopping = true;
                self.flush_chunk();
                if let Some(exit) = self.exit.clone() {
                    let _ = reply.send(Ok(exit));
                    return false;
                }
                self.set_process(ProcessState::Closing);
                let active = self.reducer.is_active();
                let session_id = self.expected_session_id.clone();
                let attached = self.attachment == AttachmentState::Attached;
                let transport = self.transport.clone();
                let internal = self.internal.clone();
                let budget = self.config.timeouts.shutdown;
                tokio::spawn(async move {
                    let start = Instant::now();
                    if attached && active {
                        let _ = transport
                            .notify("session/cancel", json!({ "sessionId": session_id }))
                            .await;
                        time::sleep(limits::ACTIVE_TURN_CANCEL_GRACE).await;
                    }
                    if attached {
                        let _ = transport
                            .request(
                                "session/close",
                                json!({ "sessionId": session_id }),
                                limits::CLOSE_REQUEST_TIMEOUT,
                            )
                            .await;
                    }
                    let remaining = budget.saturating_sub(start.elapsed()).max(Duration::from_secs(1));
                    let exit = transport.shutdown(remaining).await;
                    let _ = internal.send(Internal::Stopped { exit, reply }).await;
                });
            }
        }
        true
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            handle: self.handle.clone(),
            provider: self.launch.provider(),
            agent_session_id: self.agent_session_id.clone(),
            process: self.process,
            attachment: self.attachment,
            capabilities: self.capabilities.clone(),
            foreground: self.reducer.foreground(),
            autonomous_turns: self.reducer.active_autonomous(),
            detached_calls: self.detached.clone(),
            tool_calls: self.tool_calls.clone(),
            config_options: self.config_options.clone(),
            available_commands: self.available_commands.clone(),
            pending_steers: self.pending_steers.iter().cloned().collect(),
            last_sequence: self.sequence,
            history_start: self.history.front().map(|e| e.sequence).unwrap_or(DecimalId(0)),
            history_dropped: self.history_dropped,
            exit: self.exit.clone(),
        }
    }

    async fn fail_bootstrap(&mut self, error: DesktopError) {
        let locked = error.code == ErrorCode::Locked;
        self.set_attachment(if locked {
            AttachmentState::Locked
        } else {
            AttachmentState::Detached
        });
        self.set_process(ProcessState::Closing);
        let exit = self.transport.shutdown(self.config.timeouts.shutdown).await;
        self.exit = Some(exit.clone());
        self.set_process(ProcessState::Exited);
        if !self.exited_emitted {
            self.exited_emitted = true;
            self.emit(SessionEvent::Exited(exit));
        }
        if let Some(ready) = self.ready.take() {
            let _ = ready.send(Err(error));
        }
    }

    /// Returns false when the loop should exit.
    async fn handle_internal(&mut self, internal: Internal) -> bool {
        match internal {
            Internal::InitializeResult(result) => {
                let result = match result {
                    Ok(value) => CapabilitySnapshot::from_initialize(&value),
                    Err(error) => Err(errors::map_transport_error(error)),
                };
                match result {
                    Ok(snapshot) => {
                        self.capabilities = Some(snapshot.clone());
                        self.emit(SessionEvent::Capabilities(Box::new(snapshot)));
                        self.set_process(ProcessState::Ready);
                        let session_id = self.expected_session_id.clone();
                        let cwd = self.launch.root().to_string_lossy().into_owned();
                        let control = self.config.timeouts.control;
                        let mut params = json!({ "cwd": cwd, "mcpServers": self.config.mcp_servers });
                        if let Some(meta) = self.launch.session_meta() {
                            params["_meta"] = meta;
                        }
                        if self.launch.is_resume() {
                            // `session/load` replays the whole session as
                            // updates before it answers. Progress-sensitive
                            // inactivity is enforced by the loop's tick; the
                            // request itself gets a long ceiling so large
                            // replays are not cut.
                            params["sessionId"] = Value::String(session_id);
                            self.set_attachment(AttachmentState::Replaying);
                            self.last_progress = Instant::now();
                            self.spawn_request(
                                "session/load",
                                params,
                                self.config.timeouts.turn,
                                None,
                                Internal::AttachResult,
                            );
                        } else {
                            self.set_attachment(AttachmentState::New);
                            self.spawn_request("session/new", params, control, None, Internal::AttachResult);
                        }
                    }
                    Err(error) => self.fail_bootstrap(error).await,
                }
            }
            Internal::AttachResult(result) => match result {
                Ok(value) => {
                    self.flush_chunk();
                    let returned = value
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let agent_session_id = returned.unwrap_or_else(|| self.expected_session_id.clone());
                    if agent_session_id != self.expected_session_id {
                        // On a new session the reservation was only a
                        // placeholder and the agent's own id is the expected
                        // answer. On a load, a different id back is news.
                        if self.launch.is_resume() {
                            self.emit(SessionEvent::Diagnostic {
                                text: format!(
                                    "{} attached session {agent_session_id} instead of {}",
                                    self.launch.provider().label(),
                                    self.expected_session_id
                                ),
                            });
                        }
                        self.expected_session_id = agent_session_id.clone();
                    }
                    self.agent_session_id = Some(agent_session_id);
                    if let Some(options) = value.get("configOptions") {
                        self.config_options = options.clone();
                    }
                    self.set_attachment(AttachmentState::Attached);
                    // The model and the permission mode are config options
                    // set once the session exists, not flags — so they are
                    // set here, and a refusal is reported rather than
                    // silently leaving the session on something else.
                    self.apply_session_config().await;
                    if let Some(ready) = self.ready.take() {
                        let _ = ready.send(Ok(()));
                    }
                }
                Err(error) => {
                    self.flush_chunk();
                    let error = errors::map_transport_error(error);
                    self.fail_bootstrap(error).await;
                }
            },
            Internal::PromptWritten { request_id } => {
                self.emit(SessionEvent::Submission {
                    request_id: request_id.clone(),
                    state: SubmissionState::Writing,
                    message: None,
                });
                // The prompt is in the transcript the moment the agent has
                // it. Agents echo it back too, but late — Claude Code after
                // its first tool calls — which put the user's own message
                // below the work it asked for.
                if let Some(blocks) = self.submitted_prompts.remove(&request_id) {
                    let content: Vec<ContentBlock> = blocks.iter().filter_map(|block| ContentBlock::from_value(block).ok()).collect();
                    self.echo = Some(EchoFilter::new(&content));
                    self.flush_chunk();
                    self.message_run = None;
                    self.enqueue_update(SessionUpdate::UserMessage(MessageUpdate {
                        message_id: format!("prompt-{request_id}"),
                        content,
                        replace: true,
                        has_content: true,
                    }));
                    self.flush_chunk();
                }
                // The prompt reaching the agent's input is the acceptance, and
                // waiting for the response would hold the caller for the whole
                // turn. The response still arrives; it is read as the turn's
                // outcome instead (see `PromptResult`).
                if let Some(reply) = self.pending_submits.remove(&request_id) {
                    self.open_tools.clear();
                    self.last_progress = Instant::now();
                    self.apply_turn(TurnInput::PromptAccepted);
                    self.emit(SessionEvent::Submission {
                        request_id,
                        state: SubmissionState::Accepted,
                        message: None,
                    });
                    let _ = reply.send(Ok(SubmissionOutcome::Accepted));
                }
            }
            Internal::PromptResult { request_id, result } => {
                self.flush_chunk();
                self.submitted_prompts.remove(&request_id);
                let Some(reply) = self.pending_submits.remove(&request_id) else {
                    // Already answered at the write, so this is the turn's own
                    // outcome arriving — and it is the *only* notice the turn
                    // ever ends.
                    //
                    // ACP v1 has no `state_update`: the response's
                    // `stopReason` is the completion. Treating it as
                    // redundant left a finished turn reported as running for
                    // fifty-one minutes, which also meant the settle never
                    // ran and the agent's reported task moves were never
                    // applied.
                    match result {
                        Ok(value) => {
                            let stop_reason = value.get("stopReason").and_then(Value::as_str).unwrap_or("end_turn").to_string();
                            self.apply_turn(TurnInput::StateUpdate {
                                state: "idle",
                                stop_reason: Some(&stop_reason),
                            });
                        }
                        Err(error) => {
                            let mapped = match error {
                                TransportError::Remote(rpc) => errors::map_rpc(&rpc),
                                other => errors::map_transport_error(other),
                            };
                            self.emit(SessionEvent::Submission {
                                request_id,
                                state: SubmissionState::Rejected,
                                message: Some(mapped.message.clone()),
                            });
                            self.apply_turn(TurnInput::PromptFailed { error: &mapped.message });
                        }
                    }
                    return true;
                };
                let outcome = match result {
                    Ok(_) => {
                        self.apply_turn(TurnInput::PromptAccepted);
                        self.emit(SessionEvent::Submission {
                            request_id,
                            state: SubmissionState::Accepted,
                            message: None,
                        });
                        SubmissionOutcome::Accepted
                    }
                    Err(TransportError::Remote(rpc)) => {
                        let error = errors::map_rpc(&rpc);
                        self.emit(SessionEvent::Submission {
                            request_id,
                            state: SubmissionState::Rejected,
                            message: Some(error.message.clone()),
                        });
                        SubmissionOutcome::Rejected { error }
                    }
                    Err(other) => {
                        let error = errors::map_transport_error(other);
                        self.emit(SessionEvent::Submission {
                            request_id,
                            state: SubmissionState::OutcomeUnknown,
                            message: Some(error.message.clone()),
                        });
                        SubmissionOutcome::OutcomeUnknown { error }
                    }
                };
                let _ = reply.send(Ok(outcome));
            }
            Internal::SteerResult { message_id, result, reply } => {
                self.flush_chunk();
                self.pending_steers.remove(&message_id);
                let (outcome, state) = match result {
                    // The agent injects the input into the running turn as it
                    // answers, so an answer is delivery.
                    Ok(_) => (SteerOutcome::Accepted { message_id: message_id.clone() }, SteerState::Delivered),
                    Err(TransportError::Remote(rpc)) => (SteerOutcome::Rejected { error: errors::map_rpc(&rpc) }, SteerState::Rejected),
                    Err(other) => (
                        SteerOutcome::OutcomeUnknown { error: errors::map_transport_error(other) },
                        SteerState::OutcomeUnknown,
                    ),
                };
                self.emit(SessionEvent::Steer { message_id, state });
                let _ = reply.send(Ok(outcome));
            }
            Internal::SetConfigResult { result, reply } => {
                let outcome = match result {
                    Ok(value) => {
                        if let Some(options) = value.get("configOptions") {
                            self.config_options = options.clone();
                            self.emit(SessionEvent::Update(SessionUpdate::ConfigOptions { config_options: options.clone() }));
                        }
                        Ok(value)
                    }
                    Err(error) => Err(errors::map_transport_error(error)),
                };
                let _ = reply.send(outcome);
            }
            Internal::Stopped { exit, reply } => {
                if self.exit.is_none() {
                    self.handle_exit(exit.clone());
                }
                let _ = reply.send(Ok(exit));
                return false;
            }
        }
        true
    }
}

impl ActorState {
    /// Gives a message the agent streamed without an id one of its own.
    ///
    /// Consecutive chunks of one role are one message; anything else in
    /// between — a tool call, a plan, a message of the other role — starts a
    /// new one. Ids the agent did send are left alone and end the run.
    /// Ends a running turn that has stopped: nothing on the stream and no
    /// tool call in flight for `turn_inactivity`. The agent is asked to
    /// cancel, and the turn settles as failed with the reason, so a session
    /// is never left "running" behind a dead turn. A tool call in flight —
    /// an orchestrator's `await_jobs`, a long build — keeps it alive.
    async fn check_stalled_turn(&mut self) {
        if !self.reducer.foreground().is_active() || !self.open_tools.is_empty() {
            return;
        }
        let quiet = self.last_progress.elapsed();
        if quiet <= self.config.timeouts.turn_inactivity {
            return;
        }
        let minutes = quiet.as_secs() / 60;
        if let Some(session_id) = self.agent_session_id.clone().or_else(|| Some(self.expected_session_id.clone())) {
            let _ = self.transport.notify("session/cancel", json!({ "sessionId": session_id })).await;
        }
        self.last_progress = Instant::now();
        let message = format!("the turn made no progress for {minutes} min and was cancelled");
        self.emit(SessionEvent::Diagnostic { text: message.clone() });
        self.apply_turn(TurnInput::PromptFailed { error: &message });
    }

    fn name_message(&mut self, update: SessionUpdate) -> SessionUpdate {
        let role = match &update {
            SessionUpdate::UserMessage(_) => "user",
            SessionUpdate::AgentMessage(_) => "agent",
            SessionUpdate::AgentThought(_) => "thought",
            // Usage and config changes arrive mid-message and do not end it.
            SessionUpdate::Usage(_) | SessionUpdate::ConfigOptions { .. } | SessionUpdate::AvailableCommands { .. } => {
                return update;
            }
            _ => {
                self.message_run = None;
                return update;
            }
        };
        if update.message_id().is_some_and(|id| !id.is_empty()) {
            self.message_run = None;
            return update;
        }
        let id = match &self.message_run {
            Some((running, id)) if *running == role => id.clone(),
            _ => {
                self.message_serial += 1;
                let id = format!("{role}-{}-{}", self.generation(), self.message_serial);
                self.message_run = Some((role, id.clone()));
                id
            }
        };
        update.with_message_id(id)
    }
}

/// Recognises the agent's echo of a prompt the transcript already shows.
///
/// The echo may come whole or in chunks, and may carry the prompt's text
/// alone. Text is compared with whitespace collapsed; while everything echoed
/// so far is part of the prompt, it is dropped. Anything else — a steer, a
/// message the agent made up — ends the filter and is shown.
#[derive(Debug)]
struct EchoFilter {
    expected: String,
    seen: String,
    active: bool,
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

impl EchoFilter {
    fn new(content: &[ContentBlock]) -> Self {
        let text: String = content.iter().filter_map(|block| if let ContentBlock::Text { text } = block { Some(text.as_str()) } else { None }).collect::<Vec<_>>().join("\n");
        Self { expected: collapse(&text), seen: String::new(), active: true }
    }

    fn swallows(&mut self, message: &MessageUpdate) -> bool {
        if !self.active {
            return false;
        }
        let text: String = message.content.iter().filter_map(|block| if let ContentBlock::Text { text } = block { Some(text.as_str()) } else { None }).collect();
        let candidate = if message.replace { collapse(&text) } else { collapse(&format!("{}{text}", self.seen)) };
        if candidate.is_empty() && message.content.iter().all(|block| !matches!(block, ContentBlock::Text { .. })) {
            // Images or resources only: part of the prompt's own blocks.
            return true;
        }
        if !candidate.is_empty() && self.expected.contains(&candidate) {
            self.seen = if message.replace { text } else { format!("{}{text}", self.seen) };
            return true;
        }
        self.active = false;
        false
    }
}

/// The option id to answer a permission request with, when the policy is to
/// allow it.
///
/// ACP leaves the options to the agent; the adapter's are `allow_once`,
/// `allow_always`, `reject_once`, `reject_always`, each with a `kind`. The
/// `kind` is what is matched, because it is the part ACP defines, and
/// `allow_once` is preferred over `allow_always`: a run that quietly widens
/// what the workspace allows for every future session is not something a
/// permission answer should be able to do.
fn allow_option(params: Option<&Value>) -> Option<String> {
    let options = params?.get("options")?.as_array()?;
    let by_kind = |wanted: &str| {
        options
            .iter()
            .find(|option| option.get("kind").and_then(Value::as_str) == Some(wanted))
            .and_then(|option| option.get("optionId").or_else(|| option.get("id")))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    by_kind("allow_once").or_else(|| by_kind("allow_always"))
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn request_id_string(id: &RequestId) -> String {
    match id {
        RequestId::Number(number) => number.to_string(),
        RequestId::String(text) => text.clone(),
        RequestId::Null => "null".into(),
    }
}

async fn run_loop(
    mut state: ActorState,
    mut commands: mpsc::Receiver<Command>,
    mut incoming: mpsc::Receiver<Incoming>,
    mut internal: mpsc::Receiver<Internal>,
) {
    state.emit(SessionEvent::Process {
        state: ProcessState::Starting,
        pid: state.transport.pid(),
    });
    state.set_process(ProcessState::Negotiating);
    let control = state.config.timeouts.control;
    let handshake = capabilities::initialize_params(&state.config.client);
    state.spawn_request("initialize", handshake, control, None, Internal::InitializeResult);
    let mut tick = time::interval(Duration::from_secs(1));
    let mut incoming_open = true;

    loop {
        let chunk_deadline = state.chunk_deadline;
        tokio::select! {
            biased;

            Some(message) = internal.recv() => {
                // Whatever the agent sent before this reply is handled before
                // it. A reply reaches `internal` through the request's own
                // task, so it can overtake updates already queued on
                // `incoming` — and a turn would then settle before its last
                // message was seen.
                if incoming_open {
                    while let Ok(item) = incoming.try_recv() {
                        state.handle_incoming(item).await;
                    }
                }
                if !state.handle_internal(message).await {
                    break;
                }
            }
            item = incoming.recv(), if incoming_open => {
                match item {
                    Some(item) => state.handle_incoming(item).await,
                    None => incoming_open = false,
                }
            }
            Some(command) = commands.recv() => {
                if !state.handle_command(command).await {
                    break;
                }
            }
            _ = async {
                match chunk_deadline {
                    Some(deadline) => time::sleep_until(deadline).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                state.flush_chunk();
            }
            _ = tick.tick() => {
                state.check_stalled_turn().await;
                if state.attachment == AttachmentState::Replaying
                    && state.ready.is_some()
                    && state.last_progress.elapsed() > state.config.timeouts.resume_inactivity
                {
                    let error = DesktopError::outcome_unknown(format!(
                        "session/load made no progress for {} s",
                        state.config.timeouts.resume_inactivity.as_secs()
                    ));
                    state.fail_bootstrap(error).await;
                    break;
                }
            }
            else => break,
        }
    }
    state.flush_chunk();
    // Commands that arrive after the loop ended see a closed channel and
    // resolve with NOT_READY through `SessionActor::send`.
}

/// Converts user text and optional media into ACP prompt blocks. Media is
/// validated by the attachment service before reaching here.
pub fn text_block(text: &str) -> Value {
    json!({ "type": "text", "text": text })
}

pub fn content_blocks_to_values(blocks: &[ContentBlock]) -> Vec<Value> {
    blocks
        .iter()
        .map(|block| serde_json::to_value(block).expect("content blocks serialize"))
        .collect()
}
