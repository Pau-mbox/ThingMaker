//! One watcher per session a goal runs on.
//!
//! It keeps what the runner needs to know between ticks — is a turn running,
//! when did anything last happen, what has this turn said and run — and tells
//! the engine when a foreground turn settles. A turn's record is its own:
//! started when the turn starts, so a report belongs to the turn that wrote
//! it and a burst of settles cannot re-read the same reply.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use tokio::sync::mpsc;

use super::clock;
use crate::{
    acp::updates::{ContentBlock, SessionUpdate},
    agents::{
        Provider,
        events::{QuotaSnapshot, RuntimeEvent, SubagentStatus},
    },
    supervisor::{AttachmentState, ProcessState, SessionActor, SessionEvent, TurnEffect, TurnKind, TurnPhase},
};

/// A subagent the session's stream reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeenAgent {
    pub name: String,
    pub status: SubagentStatus,
    pub harness: String,
    pub model: Option<String>,
}

/// What one foreground turn said and ran.
#[derive(Debug, Clone, Default)]
pub struct TurnRecord {
    /// Agent messages by id, in order.
    pub messages: Vec<(String, String)>,
    /// Tool calls the turn made, in order.
    pub tool_ids: Vec<String>,
    /// Tokens the stream itself reported (Gemini, which has no transcript
    /// the desktop reads).
    pub stream_tokens: i64,
    pub started_at: Option<i64>,
}

impl TurnRecord {
    pub fn text(&self) -> String {
        self.messages.iter().map(|(_, text)| text.as_str()).collect::<Vec<_>>().join("\n")
    }

    /// Whether a model answered at all.
    pub fn produced(&self) -> bool {
        self.messages.iter().any(|(_, text)| !text.trim().is_empty()) || !self.tool_ids.is_empty()
    }
}

#[derive(Debug, Clone)]
pub struct WatchState {
    pub foreground: TurnPhase,
    pub attached: bool,
    pub exited: bool,
    pub last_event_at: Option<i64>,
    pub turn: TurnRecord,
    pub agents: HashMap<String, SeenAgent>,
    /// Tokens the stream reported over the session's life.
    pub stream_tokens: i64,
}

enum Applied {
    Signal(Signal),
    NeedSnapshot,
    Nothing,
}

/// What a watcher tells the engine.
#[derive(Debug, Clone)]
pub enum Signal {
    Settled { handle: String, phase: TurnPhase, error: Option<String>, turn: TurnRecord },
    AgentsChanged { handle: String },
    Permission { handle: String, title: Option<String>, decision: &'static str },
    Quota(QuotaSnapshot),
    Exited { handle: String },
}

pub struct Watch {
    pub handle: String,
    pub provider: Provider,
    pub actor: SessionActor,
    state: Mutex<WatchState>,
}

impl std::fmt::Debug for Watch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Watch").field("handle", &self.handle).finish_non_exhaustive()
    }
}

impl Watch {
    /// Starts watching `actor`; signals go to `signals`.
    pub async fn start(actor: SessionActor, provider: Provider, signals: mpsc::UnboundedSender<Signal>) -> Arc<Self> {
        let handle = actor.handle().id.clone();
        let mut subscription = actor.subscribe();
        let snapshot = actor.snapshot().await.ok();
        let state = WatchState {
            foreground: snapshot.as_ref().map(|snapshot| snapshot.foreground).unwrap_or(TurnPhase::Idle),
            attached: snapshot.as_ref().is_some_and(|snapshot| snapshot.attachment == AttachmentState::Attached && snapshot.process != ProcessState::Exited),
            exited: snapshot.as_ref().is_some_and(|snapshot| snapshot.process == ProcessState::Exited),
            last_event_at: Some(clock::now_ms()),
            turn: TurnRecord::default(),
            agents: HashMap::new(),
            stream_tokens: 0,
        };
        let watch = Arc::new(Self { handle: handle.clone(), provider, actor: actor.clone(), state: Mutex::new(state) });
        let weak = Arc::downgrade(&watch);
        tokio::spawn(async move {
            while let Some(event) = subscription.recv().await {
                let Some(watch) = weak.upgrade() else { break };
                let signal = match watch.apply(&event.payload) {
                    Applied::Signal(signal) => Some(signal),
                    Applied::Nothing => None,
                    Applied::NeedSnapshot => watch.resync().await,
                };
                if let Some(signal) = signal
                    && signals.send(signal).is_err()
                {
                    break;
                }
                if watch.state().exited {
                    break;
                }
            }
        });
        watch
    }

    pub fn state(&self) -> std::sync::MutexGuard<'_, WatchState> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn snapshot(&self) -> WatchState {
        self.state().clone()
    }

    /// Whether nothing is in flight: the runner may prompt.
    pub fn idle(&self) -> bool {
        let state = self.state();
        !state.foreground.is_active()
    }

    pub fn attached(&self) -> bool {
        let state = self.state();
        state.attached && !state.exited
    }

    /// After a lag: the actor knows the truth.
    async fn resync(&self) -> Option<Signal> {
        let snapshot = self.actor.snapshot().await.ok()?;
        let mut state = self.state();
        let was_active = state.foreground.is_active();
        state.foreground = snapshot.foreground;
        state.attached = snapshot.attachment == AttachmentState::Attached;
        // Lagged past a settle: the actor knows it ended.
        if was_active && snapshot.foreground.is_settled() {
            let turn = std::mem::take(&mut state.turn);
            return Some(Signal::Settled { handle: self.handle.clone(), phase: snapshot.foreground, error: None, turn });
        }
        None
    }

    fn apply(&self, event: &SessionEvent) -> Applied {
        match self.apply_inner(event) {
            Some(Ok(signal)) => Applied::Signal(signal),
            Some(Err(())) => Applied::NeedSnapshot,
            None => Applied::Nothing,
        }
    }

    fn apply_inner(&self, event: &SessionEvent) -> Option<Result<Signal, ()>> {
        let now = clock::now_ms();
        let mut state = self.state();
        state.last_event_at = Some(now);
        match event {
            SessionEvent::Turn(TurnEffect::Started { kind: TurnKind::Foreground, .. }) => {
                state.foreground = TurnPhase::Running;
                state.turn = TurnRecord { started_at: Some(now), ..TurnRecord::default() };
            }
            SessionEvent::Turn(TurnEffect::Cancelling { kind: TurnKind::Foreground }) => state.foreground = TurnPhase::Cancelling,
            SessionEvent::Turn(TurnEffect::Settled { kind: TurnKind::Foreground, phase, error, stop_reason, .. }) => {
                state.foreground = *phase;
                let turn = std::mem::take(&mut state.turn);
                let error = error.clone().or_else(|| (*phase != TurnPhase::Succeeded).then(|| stop_reason.clone()).flatten());
                return Some(Ok(Signal::Settled { handle: self.handle.clone(), phase: *phase, error, turn }));
            }
            SessionEvent::Update(SessionUpdate::AgentMessage(message)) => {
                let text: String = message.content.iter().filter_map(|block| if let ContentBlock::Text { text } = block { Some(text.as_str()) } else { None }).collect();
                match state.turn.messages.iter_mut().find(|(id, _)| *id == message.message_id) {
                    Some((_, existing)) if message.replace => *existing = text,
                    Some((_, existing)) => existing.push_str(&text),
                    None => state.turn.messages.push((message.message_id.clone(), text)),
                }
            }
            SessionEvent::Update(SessionUpdate::ToolCall(patch)) | SessionEvent::Update(SessionUpdate::ToolCallUpdate(patch)) => {
                if let Some(id) = &patch.tool_call_id
                    && !state.turn.tool_ids.contains(id)
                {
                    state.turn.tool_ids.push(id.clone());
                }
            }
            SessionEvent::Update(SessionUpdate::Usage(usage)) if self.provider == crate::agents::Provider::Gemini => {
                // Gemini reports each step's input and output tokens.
                if let Some(used) = usage.used {
                    state.turn.stream_tokens += used as i64;
                    state.stream_tokens += used as i64;
                }
            }
            SessionEvent::RuntimeEvent(RuntimeEvent::SubagentStateChanged { id, name, status, harness, model, .. }) => {
                let seen = SeenAgent { name: name.clone(), status: *status, harness: harness.clone(), model: model.clone() };
                if state.agents.get(id) != Some(&seen) {
                    state.agents.insert(id.clone(), seen);
                    return Some(Ok(Signal::AgentsChanged { handle: self.handle.clone() }));
                }
            }
            SessionEvent::Attachment { state: attachment, .. } => state.attached = *attachment == AttachmentState::Attached,
            SessionEvent::Process { state: process, .. } => {
                if *process == ProcessState::Exited {
                    state.exited = true;
                }
            }
            SessionEvent::Quota(snapshot) => return Some(Ok(Signal::Quota(snapshot.clone()))),
            SessionEvent::PermissionRequest { title, decision, .. } => {
                return Some(Ok(Signal::Permission { handle: self.handle.clone(), title: title.clone(), decision }));
            }
            SessionEvent::Exited(_) => {
                state.exited = true;
                state.attached = false;
                if state.foreground.is_active() {
                    state.foreground = TurnPhase::Unknown;
                }
                return Some(Ok(Signal::Exited { handle: self.handle.clone() }));
            }
            SessionEvent::SnapshotNeeded { .. } => return Some(Err(())),
            _ => {}
        }
        None
    }
}
