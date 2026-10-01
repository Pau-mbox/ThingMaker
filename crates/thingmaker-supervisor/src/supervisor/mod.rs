//! Session actors, state machines and the event envelope (spec section 7, 8.4).
//!
//! One native actor owns each live agent attachment (ARCH-01). UI navigation
//! never owns runtime lifetime (ARCH-02): closing a pane only drops an event
//! subscription. Every command resolves exactly once with a result or a typed
//! error (F11).

pub mod connection;
pub mod events;
pub mod session_actor;
pub mod state;

pub use crate::agents::{AgentLaunch, Provider};
pub use events::{EventEnvelope, EventSubscription, SessionEvent};
pub use session_actor::{
    SessionActor, SessionActorConfig, Snapshot, SteerOutcome, SubmissionOutcome, Timeouts,
};
pub use state::{
    ApprovalState, AttachmentState, DetachedCallState, ProcessState, SessionReducer, SubmissionState,
    TurnEffect, TurnInput, TurnKind, TurnPhase,
};
