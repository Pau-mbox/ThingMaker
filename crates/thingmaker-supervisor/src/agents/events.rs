//! What the desktop knows about an agent beyond its transcript: which
//! subagents it is running, and how much of the account's window is left.
//!
//! Both are provider-neutral on purpose. Claude Code announces a subagent as
//! an `Agent`/`Task` tool call and Codex as a collaboration item; Claude
//! reports its window as `_claude/rateLimit` on a usage update and Codex as
//! `account/rateLimits/updated`. Each provider's adapter translates into the
//! types below, so the inspector's agent tree, the run monitor, the task owner
//! column and the router never learn which agent they are watching.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentStatus {
    Starting,
    Working,
    Idle,
    Removed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GenerationOutcome {
    Success,
    Failed,
}

/// Agent-side facts that are not part of the ACP transcript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum RuntimeEvent {
    SubagentStateChanged {
        id: String,
        name: String,
        status: SubagentStatus,
        #[serde(default)]
        outcome: Option<GenerationOutcome>,
        generation: u64,
        task: String,
        #[serde(default)]
        parent_id: Option<String>,
        #[serde(default)]
        parent_name: Option<String>,
        /// Where the subagent runs: `claude-code`, `codex`, or a worker the
        /// desktop started for another session (`thingmaker:<provider>`).
        harness: String,
        #[serde(default)]
        model: Option<String>,
        created_at_unix_ms: u64,
        generation_started_at_unix_ms: u64,
        #[serde(default)]
        generation_finished_at_unix_ms: Option<u64>,
    },
    SubagentDescendantsRemoved {
        ancestor_id: String,
    },
}

/// Whether the account will take another turn, in the provider's own words
/// reduced to three.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuotaStatus {
    /// Room left, as far as the provider says.
    Allowed,
    /// Room left, but the provider has warned it is close.
    Warning,
    /// Spent until the earliest window's reset.
    Rejected,
}

/// One usage window (five hours, a week, a model-specific week, …).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    /// The provider's name for the window, verbatim (`five_hour`,
    /// `seven_day_opus`, `primary`, …). Shown, never parsed.
    pub kind: String,
    /// Percentage used, 0–100, when the provider says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_minutes: Option<u64>,
    /// Unix seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<u64>,
}

/// The account's quota as one provider last reported it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaSnapshot {
    pub provider: super::Provider,
    pub status: QuotaStatus,
    pub windows: Vec<QuotaWindow>,
    /// Plan name when the provider reports one (`plus`, `team`, `max`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    pub observed_at_unix_ms: u64,
}

impl QuotaSnapshot {
    /// The time the account is next usable, for a spent one: the latest reset
    /// among the windows that are full, else the earliest reset named.
    pub fn available_again_at(&self) -> Option<u64> {
        if self.status != QuotaStatus::Rejected {
            return None;
        }
        let full = self
            .windows
            .iter()
            .filter(|window| window.used_percent.is_some_and(|used| used >= 100.0))
            .filter_map(|window| window.resets_at)
            .max();
        full.or_else(|| self.windows.iter().filter_map(|window| window.resets_at).min())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::Provider;

    #[test]
    fn a_spent_account_is_available_when_its_full_windows_reset() {
        let snapshot = QuotaSnapshot {
            provider: Provider::Codex,
            status: QuotaStatus::Rejected,
            windows: vec![
                QuotaWindow { kind: "primary".into(), used_percent: Some(100.0), window_minutes: Some(300), resets_at: Some(200) },
                QuotaWindow { kind: "secondary".into(), used_percent: Some(70.0), window_minutes: Some(10080), resets_at: Some(900) },
            ],
            plan: Some("plus".into()),
            observed_at_unix_ms: 0,
        };
        assert_eq!(snapshot.available_again_at(), Some(200));
        let allowed = QuotaSnapshot { status: QuotaStatus::Allowed, ..snapshot.clone() };
        assert_eq!(allowed.available_again_at(), None);
        let unnamed = QuotaSnapshot {
            windows: vec![QuotaWindow { kind: "five_hour".into(), used_percent: None, window_minutes: None, resets_at: Some(500) }],
            ..snapshot
        };
        assert_eq!(unnamed.available_again_at(), Some(500));
    }

    #[test]
    fn subagent_events_keep_their_wire_shape() {
        let event = RuntimeEvent::SubagentStateChanged {
            id: "c1".into(),
            name: "7.3-scout".into(),
            status: SubagentStatus::Working,
            outcome: None,
            generation: 1,
            task: "general-purpose".into(),
            parent_id: None,
            parent_name: None,
            harness: "claude-code".into(),
            model: Some("opus".into()),
            created_at_unix_ms: 1,
            generation_started_at_unix_ms: 1,
            generation_finished_at_unix_ms: None,
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["event"], "subagent_state_changed");
        assert_eq!(value["status"], "working");
    }
}
