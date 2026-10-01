//! What the engine needs from the application that hosts it.
//!
//! The engine decides; the host knows how to find a provider's program, open
//! a session the way the user's own tabs are opened, ask an account for its
//! usage, and tell the interface what happened. Everything here is the host's
//! side of that line, so the engine is tested with a mock host and the real
//! mock providers.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::{
    DesktopError,
    agents::{Provider, events::QuotaSnapshot},
    delegation::{Combo, jobs::BoxFuture},
    supervisor::SessionActor,
};

/// A session the engine can drive.
#[derive(Debug, Clone)]
pub struct LiveSession {
    pub actor: SessionActor,
    /// The attachment handle the interface addresses it by.
    pub handle: String,
    /// The id the agent keeps its transcript under.
    pub agent_session_id: String,
    /// The desktop row a goal points at.
    pub row_id: String,
    pub workspace_id: String,
    pub provider: Provider,
    pub root: PathBuf,
    /// The model it runs, when the host knows.
    pub model: Option<String>,
}

/// A session the engine asks the host to open.
#[derive(Debug, Clone, Default)]
pub struct OpenSpec {
    pub workspace_id: String,
    pub provider: Provider,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// The team it leads; `None` keeps the user's default.
    pub combo: Option<Combo>,
    /// Resume this agent session instead of starting a new one.
    pub resume: Option<String>,
}

/// What the runner is doing for one goal, for the goal's strip. Held in
/// memory: it is the runner's present, and the record holds its past.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeView {
    /// When a parked goal expects its account back.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_at: Option<i64>,
    pub last_reason: String,
    pub last_reason_at: i64,
    /// A tick is acting on the goal now.
    pub ticking: bool,
    /// When the current "cannot act" reason first appeared.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stalled_since: Option<i64>,
    pub stall_notified: bool,
    /// The attachment the goal runs on now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_handle: Option<String>,
    /// What the spend forecast says about the next turn, when it has an
    /// opinion.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forecast: Option<String>,
}

/// What the interface hears from the engine.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum EngineEvent {
    /// The goal's record changed: re-read it.
    Changed { goal_id: String, workspace_id: String, agent_session_id: Option<String> },
    /// What the runner is doing now, for the goal's strip.
    Runtime { goal_id: String, runtime: RuntimeView },
    /// A line for the announcer.
    Announce { goal_id: String, text: String },
    /// Something a person has to see: a question, a plan change, a block, the end.
    Notify { goal_id: String, workspace_id: String, attention: &'static str, text: String },
    /// The engine opened a session; the interface attaches to it.
    SessionOpened { workspace_id: String, handle: String, agent_session_id: String },
    /// The goal moved to another session.
    Moved { goal_id: String, from_agent_session_id: Option<String>, to_agent_session_id: String, to_handle: String },
}

pub trait EngineHost: Send + Sync {
    /// The live session behind a desktop row, if it is open.
    fn live(&self, row_id: &str) -> Option<LiveSession>;
    /// The live session with this attachment handle.
    fn live_handle(&self, handle: &str) -> Option<LiveSession>;
    /// Opens or resumes a session, registered with the host like the user's
    /// own, leading the team it is given.
    fn open(&self, spec: OpenSpec) -> BoxFuture<Result<LiveSession, DesktopError>>;
    /// The account's usage as its provider reports it, without a turn.
    fn quota(&self, provider: Provider) -> BoxFuture<Option<QuotaSnapshot>>;
    /// Paid input plus output so far, from the provider's own transcript.
    fn session_tokens(&self, session: &LiveSession) -> Option<i64>;
    /// Installs the `big-thing` skill; whether it is there.
    fn install_skill(&self) -> bool;
    /// Installs the Claude delegate into the workspace; whether it is there.
    fn install_delegate(&self, root: &Path) -> bool;
    /// Providers that are installed and signed in, in order of preference.
    fn usable_providers(&self) -> Vec<Provider>;
    fn emit(&self, event: EngineEvent);
}
