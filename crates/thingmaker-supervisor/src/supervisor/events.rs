//! Ordered event envelopes published by a session actor (ARCH-05).
//!
//! `sequence` is an app-local stream cursor for resubscription, never an ACP
//! replay cursor. Subscribers that fall behind receive a `SnapshotNeeded`
//! marker and must fetch a fresh snapshot instead of guessing missing deltas
//! (REC-04).

use std::sync::Arc;

use serde::Serialize;
use tokio::sync::broadcast;

use super::state::{
    AttachmentState, DetachedCallState, ProcessState, SubmissionState, TurnEffect,
};
use crate::{
    DESKTOP_API_VERSION,
    ids::{DecimalId, SessionHandle},
    acp::{capabilities::CapabilitySnapshot, updates::SessionUpdate},
    agents::events::{QuotaSnapshot, RuntimeEvent},
    transport::ExitInfo,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    pub api_version: u32,
    pub session: SessionHandle,
    pub sequence: DecimalId,
    pub payload: SessionEvent,
}

impl EventEnvelope {
    pub fn new(session: SessionHandle, sequence: DecimalId, payload: SessionEvent) -> Self {
        Self {
            api_version: DESKTOP_API_VERSION,
            session,
            sequence,
            payload,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
// `rename_all` renames variants only; `rename_all_fields` is what makes the
// struct-variant fields camelCase for the renderer contract.
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
// Events are wrapped in `Arc` once and streamed; variant size is not on a hot
// path, and boxing `Update` would complicate every pattern match on it.
#[allow(clippy::large_enum_variant)]
pub enum SessionEvent {
    Process {
        state: ProcessState,
        #[serde(skip_serializing_if = "Option::is_none")]
        pid: Option<u32>,
    },
    Attachment {
        state: AttachmentState,
        #[serde(skip_serializing_if = "Option::is_none")]
        agent_session_id: Option<String>,
    },
    Capabilities(Box<CapabilitySnapshot>),
    /// A decoded `session/update`, already limited for presentation.
    Update(SessionUpdate),
    RuntimeEvent(RuntimeEvent),
    /// The account's quota as the agent last reported it.
    Quota(QuotaSnapshot),
    Diagnostic {
        text: String,
    },
    Turn(TurnEffect),
    Submission {
        request_id: String,
        state: SubmissionState,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Steer {
        message_id: String,
        state: SteerState,
    },
    DetachedCall {
        call_id: String,
        state: DetachedCallState,
    },
    /// The agent asked for a permission decision, and this is what the
    /// attachment's permission stance answered (F14, SEC-07). Every decision
    /// is on the stream, so none is silently consented.
    PermissionRequest {
        request_id: String,
        title: Option<String>,
        decision: &'static str,
    },
    Exited(ExitInfo),
    Overflow {
        stream: &'static str,
        bytes: usize,
        limit: usize,
        fatal: bool,
    },
    /// Emitted to a lagging subscriber; fetch a snapshot and resubscribe.
    SnapshotNeeded {
        reason: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        skipped: Option<u64>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SteerState {
    Pending,
    Delivered,
    Rejected,
    OutcomeUnknown,
}

/// A bounded subscription. Lag is converted into a `SnapshotNeeded` envelope.
pub struct EventSubscription {
    receiver: broadcast::Receiver<Arc<EventEnvelope>>,
    handle: SessionHandle,
}

impl EventSubscription {
    pub fn new(receiver: broadcast::Receiver<Arc<EventEnvelope>>, handle: SessionHandle) -> Self {
        Self { receiver, handle }
    }

    /// Returns `None` when the actor has stopped and no events remain.
    pub async fn recv(&mut self) -> Option<Arc<EventEnvelope>> {
        match self.receiver.recv().await {
            Ok(event) => Some(event),
            Err(broadcast::error::RecvError::Lagged(skipped)) => Some(Arc::new(EventEnvelope::new(
                self.handle.clone(),
                DecimalId(0),
                SessionEvent::SnapshotNeeded {
                    reason: "subscriber lagged",
                    skipped: Some(skipped),
                },
            ))),
            Err(broadcast::error::RecvError::Closed) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::state::{TurnKind, TurnPhase};

    fn handle() -> SessionHandle {
        SessionHandle { id: "s".into(), attachment_generation: DecimalId(1) }
    }

    #[test]
    fn struct_variant_fields_serialize_in_camel_case() {
        let submission = EventEnvelope::new(
            handle(),
            DecimalId(1),
            SessionEvent::Submission { request_id: "r".into(), state: SubmissionState::Accepted, message: None },
        );
        let json = serde_json::to_value(&submission).unwrap();
        assert_eq!(json["apiVersion"], 1);
        assert_eq!(json["session"]["attachmentGeneration"], "1");
        assert_eq!(json["payload"]["type"], "submission");
        assert_eq!(json["payload"]["requestId"], "r", "{json}");
        assert!(json["payload"].get("request_id").is_none());

        let settled = serde_json::to_value(SessionEvent::Turn(TurnEffect::Settled {
            kind: TurnKind::Foreground,
            turn_id: Some(3),
            phase: TurnPhase::Succeeded,
            stop_reason: Some("end_turn".into()),
            error: None,
        }))
        .unwrap();
        assert_eq!(settled["effect"], "settled");
        assert_eq!(settled["stopReason"], "end_turn", "{settled}");
        assert_eq!(settled["turnId"], 3);

        let steer = serde_json::to_value(SessionEvent::Steer { message_id: "m".into(), state: SteerState::Pending }).unwrap();
        assert_eq!(steer["messageId"], "m");
        let detached = serde_json::to_value(SessionEvent::DetachedCall { call_id: "c".into(), state: DetachedCallState::Active }).unwrap();
        assert_eq!(detached["callId"], "c");
        let permission = serde_json::to_value(SessionEvent::PermissionRequest { request_id: "p".into(), title: None, decision: "cancelled" }).unwrap();
        assert_eq!(permission["requestId"], "p");
        let attachment = serde_json::to_value(SessionEvent::Attachment { state: AttachmentState::Attached, agent_session_id: Some("k".into()) }).unwrap();
        assert_eq!(attachment["agentSessionId"], "k");
    }
}
