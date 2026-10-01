//! Internal state machines (spec section 8.4).
//!
//! These are our states, not wire strings. Critical rules:
//!
//! - a transport restart increments the attachment generation and inputs from
//!   older generations are ignored (callback fencing, F03);
//! - a turn settles at most once; repeated terminal events are no-ops;
//! - prompt acceptance is not completion;
//! - a transport failure during a turn yields `Unknown`, never "cancelled" or
//!   "rolled back".

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessState {
    Stopped,
    Starting,
    Negotiating,
    Ready,
    Degraded,
    Closing,
    Exited,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentState {
    New,
    Replaying,
    Attached,
    Locked,
    Recovering,
    Detached,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmissionState {
    Draft,
    Validated,
    Queued,
    Writing,
    Accepted,
    OutcomeUnknown,
    Rejected,
}

impl SubmissionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Validated => "validated",
            Self::Queued => "queued",
            Self::Writing => "writing",
            Self::Accepted => "accepted",
            Self::OutcomeUnknown => "outcome_unknown",
            Self::Rejected => "rejected",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "draft" => Self::Draft,
            "validated" => Self::Validated,
            "queued" => Self::Queued,
            "writing" => Self::Writing,
            "accepted" => Self::Accepted,
            "outcome_unknown" => Self::OutcomeUnknown,
            "rejected" => Self::Rejected,
            _ => return None,
        })
    }

    /// Legal forward transitions. Uncertain outcomes never move back to a
    /// resendable state automatically.
    pub fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Draft, Self::Validated)
                | (Self::Validated, Self::Queued)
                | (Self::Queued, Self::Writing)
                | (Self::Writing, Self::Accepted)
                | (Self::Writing, Self::OutcomeUnknown)
                | (Self::Writing, Self::Rejected)
                | (Self::Queued, Self::Rejected)
                | (Self::OutcomeUnknown, Self::Accepted)
                | (Self::OutcomeUnknown, Self::Rejected)
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnPhase {
    Idle,
    Running,
    AwaitingUser,
    Cancelling,
    Succeeded,
    Failed,
    Cancelled,
    /// The transport was lost while the turn was active. The outcome must be
    /// reconciled from durable history; nothing is assumed rolled back.
    Unknown,
}

impl TurnPhase {
    pub fn is_active(self) -> bool {
        matches!(self, Self::Running | Self::AwaitingUser | Self::Cancelling)
    }

    pub fn is_settled(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled | Self::Unknown)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetachedCallState {
    Active,
    CancellationRequested,
    Completed,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalState {
    Pending,
    Resolved,
    Expired,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnKind {
    Foreground,
    Autonomous,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "effect", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum TurnEffect {
    Started {
        kind: TurnKind,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<i64>,
    },
    Cancelling {
        kind: TurnKind,
    },
    Settled {
        kind: TurnKind,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<i64>,
        phase: TurnPhase,
        #[serde(skip_serializing_if = "Option::is_none")]
        stop_reason: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Ignored {
        reason: &'static str,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnInput<'a> {
    /// `session/prompt` returned successfully.
    PromptAccepted,
    /// ACP `state_update`.
    StateUpdate {
        state: &'a str,
        stop_reason: Option<&'a str>,
    },
    /// A turn the agent started on its own (a background task finishing, a
    /// scheduled follow-up), identified by the agent's own turn number.
    AutonomousTurn {
        turn_id: i64,
        active: bool,
        error: Option<&'a str>,
    },
    CancelRequested,
    TransportLost,
    /// `session/prompt` came back with an error *after* the turn had already
    /// been reported as started.
    ///
    /// For an agent that answers `session/prompt` only when the turn ends
    /// (docs/plans/odyssey-second-orchestrator.md §2.1) the request's result
    /// is the turn's outcome, not its acceptance — so a failure arrives here
    /// rather than as a rejected submission, and has to settle the foreground
    /// turn with its message.
    PromptFailed {
        error: &'a str,
    },
}

/// Tracks foreground and autonomous turns for one attachment generation.
#[derive(Debug, Clone)]
pub struct SessionReducer {
    generation: u64,
    foreground: TurnPhase,
    autonomous: BTreeMap<i64, TurnPhase>,
}

impl SessionReducer {
    pub fn new(generation: u64) -> Self {
        Self {
            generation,
            foreground: TurnPhase::Idle,
            autonomous: BTreeMap::new(),
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn foreground(&self) -> TurnPhase {
        self.foreground
    }

    pub fn active_autonomous(&self) -> Vec<i64> {
        self.autonomous
            .iter()
            .filter(|(_, phase)| phase.is_active())
            .map(|(id, _)| *id)
            .collect()
    }

    /// True when any foreground or autonomous work is in flight.
    pub fn is_active(&self) -> bool {
        self.foreground.is_active() || self.autonomous.values().any(|phase| phase.is_active())
    }

    pub fn apply(&mut self, generation: u64, input: TurnInput<'_>) -> Vec<TurnEffect> {
        if generation != self.generation {
            return vec![TurnEffect::Ignored {
                reason: "stale attachment generation",
            }];
        }
        match input {
            TurnInput::PromptAccepted => self.start_foreground("turn already running"),
            TurnInput::StateUpdate { state, stop_reason } => {
                if state == "idle" {
                    if !self.foreground.is_active() {
                        return vec![TurnEffect::Ignored {
                            reason: "no active foreground turn to settle",
                        }];
                    }
                    let phase = match stop_reason {
                        Some("cancelled") => TurnPhase::Cancelled,
                        Some("refusal") => TurnPhase::Failed,
                        _ if self.foreground == TurnPhase::Cancelling => TurnPhase::Cancelled,
                        _ => TurnPhase::Succeeded,
                    };
                    self.foreground = phase;
                    vec![TurnEffect::Settled {
                        kind: TurnKind::Foreground,
                        turn_id: None,
                        phase,
                        stop_reason: stop_reason.map(str::to_string),
                        error: None,
                    }]
                } else if state == "awaiting_user" || state == "waiting_for_user" {
                    if !self.foreground.is_active() {
                        let mut effects = self.start_foreground("turn already running");
                        self.foreground = TurnPhase::AwaitingUser;
                        effects.retain(|effect| !matches!(effect, TurnEffect::Ignored { .. }));
                        return effects;
                    }
                    self.foreground = TurnPhase::AwaitingUser;
                    Vec::new()
                } else {
                    // `running` and any future non-idle state mean work is active.
                    if self.foreground == TurnPhase::Cancelling {
                        return vec![TurnEffect::Ignored {
                            reason: "cancellation already requested",
                        }];
                    }
                    self.start_foreground("turn already running")
                }
            }
            TurnInput::PromptFailed { error } => {
                if !self.foreground.is_active() {
                    return vec![TurnEffect::Ignored {
                        reason: "no active foreground turn to fail",
                    }];
                }
                self.foreground = TurnPhase::Failed;
                vec![TurnEffect::Settled {
                    kind: TurnKind::Foreground,
                    turn_id: None,
                    phase: TurnPhase::Failed,
                    stop_reason: None,
                    error: Some(error.to_string()),
                }]
            }
            TurnInput::AutonomousTurn {
                turn_id,
                active,
                error,
            } => {
                if active {
                    match self.autonomous.get(&turn_id) {
                        Some(phase) if phase.is_active() => vec![TurnEffect::Ignored {
                            reason: "duplicate autonomous turn start",
                        }],
                        Some(_) => vec![TurnEffect::Ignored {
                            reason: "autonomous turn already settled",
                        }],
                        None => {
                            self.autonomous.insert(turn_id, TurnPhase::Running);
                            vec![TurnEffect::Started {
                                kind: TurnKind::Autonomous,
                                turn_id: Some(turn_id),
                            }]
                        }
                    }
                } else {
                    match self.autonomous.get(&turn_id) {
                        Some(phase) if phase.is_active() => {
                            let phase = if error.is_some() {
                                TurnPhase::Failed
                            } else {
                                TurnPhase::Succeeded
                            };
                            self.autonomous.insert(turn_id, phase);
                            vec![TurnEffect::Settled {
                                kind: TurnKind::Autonomous,
                                turn_id: Some(turn_id),
                                phase,
                                stop_reason: None,
                                error: error.map(str::to_string),
                            }]
                        }
                        Some(_) => vec![TurnEffect::Ignored {
                            reason: "duplicate autonomous settlement",
                        }],
                        None => vec![TurnEffect::Ignored {
                            reason: "settlement for unknown autonomous turn",
                        }],
                    }
                }
            }
            TurnInput::CancelRequested => {
                if matches!(self.foreground, TurnPhase::Running | TurnPhase::AwaitingUser) {
                    self.foreground = TurnPhase::Cancelling;
                    vec![TurnEffect::Cancelling {
                        kind: TurnKind::Foreground,
                    }]
                } else {
                    vec![TurnEffect::Ignored {
                        reason: "no cancellable foreground turn",
                    }]
                }
            }
            TurnInput::TransportLost => {
                let mut effects = Vec::new();
                if self.foreground.is_active() {
                    self.foreground = TurnPhase::Unknown;
                    effects.push(TurnEffect::Settled {
                        kind: TurnKind::Foreground,
                        turn_id: None,
                        phase: TurnPhase::Unknown,
                        stop_reason: None,
                        error: Some("transport lost; outcome unknown".into()),
                    });
                }
                for (turn_id, phase) in self.autonomous.iter_mut() {
                    if phase.is_active() {
                        *phase = TurnPhase::Unknown;
                        effects.push(TurnEffect::Settled {
                            kind: TurnKind::Autonomous,
                            turn_id: Some(*turn_id),
                            phase: TurnPhase::Unknown,
                            stop_reason: None,
                            error: Some("transport lost; outcome unknown".into()),
                        });
                    }
                }
                if effects.is_empty() {
                    effects.push(TurnEffect::Ignored {
                        reason: "no active turns",
                    });
                }
                effects
            }
        }
    }

    fn start_foreground(&mut self, ignored: &'static str) -> Vec<TurnEffect> {
        if self.foreground.is_active() {
            return vec![TurnEffect::Ignored { reason: ignored }];
        }
        self.foreground = TurnPhase::Running;
        vec![TurnEffect::Started {
            kind: TurnKind::Foreground,
            turn_id: None,
        }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreground_turn_settles_exactly_once() {
        let mut reducer = SessionReducer::new(1);
        assert_eq!(
            reducer.apply(1, TurnInput::PromptAccepted),
            vec![TurnEffect::Started { kind: TurnKind::Foreground, turn_id: None }]
        );
        assert!(matches!(reducer.apply(1, TurnInput::StateUpdate { state: "running", stop_reason: None })[0], TurnEffect::Ignored { .. }));
        let settled = reducer.apply(1, TurnInput::StateUpdate { state: "idle", stop_reason: Some("end_turn") });
        assert!(matches!(settled[0], TurnEffect::Settled { phase: TurnPhase::Succeeded, .. }));
        let duplicate = reducer.apply(1, TurnInput::StateUpdate { state: "idle", stop_reason: Some("end_turn") });
        assert!(matches!(duplicate[0], TurnEffect::Ignored { .. }));
        assert_eq!(reducer.foreground(), TurnPhase::Succeeded);
        // A new running state begins a new turn.
        assert!(matches!(reducer.apply(1, TurnInput::StateUpdate { state: "running", stop_reason: None })[0], TurnEffect::Started { .. }));
    }

    #[test]
    fn stale_generation_inputs_are_fenced() {
        let mut reducer = SessionReducer::new(2);
        assert_eq!(
            reducer.apply(1, TurnInput::PromptAccepted),
            vec![TurnEffect::Ignored { reason: "stale attachment generation" }]
        );
        assert_eq!(reducer.foreground(), TurnPhase::Idle);
    }

    #[test]
    fn cancellation_and_refusal_map_to_distinct_phases() {
        let mut reducer = SessionReducer::new(1);
        reducer.apply(1, TurnInput::PromptAccepted);
        assert!(matches!(reducer.apply(1, TurnInput::CancelRequested)[0], TurnEffect::Cancelling { .. }));
        assert!(matches!(reducer.apply(1, TurnInput::StateUpdate { state: "running", stop_reason: None })[0], TurnEffect::Ignored { .. }));
        assert!(matches!(reducer.apply(1, TurnInput::StateUpdate { state: "idle", stop_reason: None })[0], TurnEffect::Settled { phase: TurnPhase::Cancelled, .. }));
        let mut reducer = SessionReducer::new(1);
        reducer.apply(1, TurnInput::PromptAccepted);
        assert!(matches!(reducer.apply(1, TurnInput::StateUpdate { state: "idle", stop_reason: Some("refusal") })[0], TurnEffect::Settled { phase: TurnPhase::Failed, .. }));
    }

    #[test]
    fn autonomous_turns_dedupe_repeated_lifecycle_events() {
        let mut reducer = SessionReducer::new(1);
        let inputs = [true, true, false, false];
        let effects: Vec<TurnEffect> = inputs
            .iter()
            .flat_map(|active| reducer.apply(1, TurnInput::AutonomousTurn { turn_id: 41, active: *active, error: None }))
            .collect();
        let started = effects.iter().filter(|e| matches!(e, TurnEffect::Started { .. })).count();
        let settled = effects.iter().filter(|e| matches!(e, TurnEffect::Settled { .. })).count();
        assert_eq!((started, settled), (1, 1));
        assert!(reducer.active_autonomous().is_empty());
        assert!(matches!(reducer.apply(1, TurnInput::AutonomousTurn { turn_id: 99, active: false, error: None })[0], TurnEffect::Ignored { .. }));
        let errored = reducer.apply(1, TurnInput::AutonomousTurn { turn_id: 7, active: true, error: None });
        assert!(matches!(errored[0], TurnEffect::Started { .. }));
        assert!(matches!(reducer.apply(1, TurnInput::AutonomousTurn { turn_id: 7, active: false, error: Some("boom") })[0], TurnEffect::Settled { phase: TurnPhase::Failed, .. }));
    }

    #[test]
    fn transport_loss_marks_active_turns_unknown_not_cancelled() {
        let mut reducer = SessionReducer::new(1);
        reducer.apply(1, TurnInput::PromptAccepted);
        reducer.apply(1, TurnInput::AutonomousTurn { turn_id: 5, active: true, error: None });
        let effects = reducer.apply(1, TurnInput::TransportLost);
        assert_eq!(effects.len(), 2);
        assert!(effects.iter().all(|e| matches!(e, TurnEffect::Settled { phase: TurnPhase::Unknown, .. })));
        assert!(!reducer.is_active());
        assert!(matches!(reducer.apply(1, TurnInput::TransportLost)[0], TurnEffect::Ignored { .. }));
    }

    #[test]
    fn submission_transitions_never_auto_resend() {
        assert!(SubmissionState::Writing.can_transition_to(SubmissionState::OutcomeUnknown));
        assert!(!SubmissionState::OutcomeUnknown.can_transition_to(SubmissionState::Writing));
        assert!(!SubmissionState::OutcomeUnknown.can_transition_to(SubmissionState::Queued));
        assert!(SubmissionState::OutcomeUnknown.can_transition_to(SubmissionState::Accepted));
        assert_eq!(SubmissionState::parse("outcome_unknown"), Some(SubmissionState::OutcomeUnknown));
        assert_eq!(SubmissionState::Accepted.as_str(), "accepted");
    }
}
