//! Codex subagents, as the rest of the desktop already understands them.
//!
//! Codex raises a subagent with a collaboration tool call (`spawnAgent`),
//! which the bridge forwards as a tool call named `collab:spawnAgent` with the
//! prompt, model and effort in `rawInput`. That is translated here into the
//! same `subagent_state_changed` event a Claude Code `Task` becomes, so the
//! agent tree, the run monitor and the task owner column need no Codex case.

use serde_json::Value;

use crate::{
    acp::updates::ToolPatch,
    agents::events::{GenerationOutcome, RuntimeEvent, SubagentStatus},
};

/// The harness name a Codex subagent is recorded under.
pub const HARNESS: &str = "codex";

/// Translates a collaboration tool call into a subagent event, or `None`
/// when the patch is not the spawn of one.
pub fn subagent_event(patch: &ToolPatch, session_model: Option<&str>, at_unix_ms: u64) -> Option<RuntimeEvent> {
    if patch.name.as_deref() != Some("collab:spawnAgent") {
        return None;
    }
    let id = patch.tool_call_id.clone()?;
    let input = patch.raw_input.clone().unwrap_or(Value::Null);
    let prompt = input.get("prompt").and_then(Value::as_str).unwrap_or_default();
    // The skill's rule — name a subagent after its task, `7.3-<slug>` — puts
    // the name on the prompt's first line.
    let name = prompt
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| line.split(':').next().unwrap_or(line).trim().chars().take(60).collect::<String>())
        .or_else(|| patch.title.clone())?;
    let (status, outcome, finished) = match patch.status.as_deref() {
        None | Some("pending") => (SubagentStatus::Starting, None, None),
        Some("completed") => (SubagentStatus::Idle, Some(GenerationOutcome::Success), Some(at_unix_ms)),
        Some("failed") => (SubagentStatus::Idle, Some(GenerationOutcome::Failed), Some(at_unix_ms)),
        Some(_) => (SubagentStatus::Working, None, None),
    };
    Some(RuntimeEvent::SubagentStateChanged {
        id,
        name,
        status,
        outcome,
        generation: 1,
        task: prompt.chars().take(400).collect(),
        parent_id: None,
        parent_name: None,
        harness: HARNESS.to_string(),
        model: input.get("model").and_then(Value::as_str).map(str::to_string).or_else(|| session_model.map(str::to_string)),
        created_at_unix_ms: at_unix_ms,
        generation_started_at_unix_ms: at_unix_ms,
        generation_finished_at_unix_ms: finished,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn patch(status: &str) -> ToolPatch {
        ToolPatch::from_object(
            json!({"toolCallId": "k1", "title": "7.3-pricing: price the tiers", "name": "collab:spawnAgent", "status": status,
                   "rawInput": {"collab": "spawnAgent", "prompt": "7.3-pricing: price the tiers\\nDetails…", "model": "gpt-6-luna"}})
            .as_object()
            .unwrap(),
        )
    }

    #[test]
    fn a_spawned_codex_agent_is_the_subagent_event_the_projection_reduces() {
        let Some(RuntimeEvent::SubagentStateChanged { name, status, model, harness, .. }) = subagent_event(&patch("in_progress"), Some("gpt-6-astra"), 5) else { panic!() };
        assert_eq!(name, "7.3-pricing");
        assert_eq!(status, SubagentStatus::Working);
        assert_eq!(model.as_deref(), Some("gpt-6-luna"), "the subagent's own model, not the session's");
        assert_eq!(harness, "codex");
        let Some(RuntimeEvent::SubagentStateChanged { status, outcome, .. }) = subagent_event(&patch("completed"), None, 9) else { panic!() };
        assert_eq!((status, outcome), (SubagentStatus::Idle, Some(GenerationOutcome::Success)));
        let other = ToolPatch::from_object(json!({"toolCallId": "c", "name": "shell"}).as_object().unwrap());
        assert!(subagent_event(&other, None, 0).is_none());
    }
}
