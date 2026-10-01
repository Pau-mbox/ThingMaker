//! Claude Code subagents, as the rest of the desktop already understands them
//! (docs/plans/odyssey-second-orchestrator.md §2.1).
//!
//! The desktop's agent tree, run monitor, dead-turn guard and task owner
//! column are built on one event, `subagent_state_changed` (`agents::events`).
//! Claude Code announces a subagent as the `Agent`/`Task` tool, which
//! arrives on the ordinary ACP update stream as a tool call whose title is the
//! Task's `description` and whose `rawInput` carries `description` and
//! `subagent_type`. That is the same information, so it is translated into the
//! same event rather than given a second representation to maintain: the
//! skill's rule — name a subagent after its task, `7.3-<slug>` — then works
//! unchanged, and so does `matchAgentToTask`.
//!
//! What is genuinely absent stays absent rather than being invented: a Claude
//! subagent has no generation count (there is one run per Task call) and no
//! per-subagent model (the adapter reports the session's), so those carry the
//! session's model and generation 1, and the harness says `claude-code` so a
//! reader can see where the row came from.

use serde_json::Value;

use crate::{
    acp::updates::ToolPatch,
    agents::events::{GenerationOutcome, RuntimeEvent, SubagentStatus},
};

/// The harness name a Claude Code native subagent is recorded under.
pub const HARNESS: &str = "claude-code";

/// Whether this tool call is a subagent. `Agent` is the newer name for the
/// same tool and the adapter maps both.
pub fn is_task_call(patch: &ToolPatch) -> bool {
    matches!(patch.name.as_deref(), Some("Task") | Some("Agent"))
        || patch
            .raw_input
            .as_ref()
            .is_some_and(|input| input.get("subagent_type").is_some() && input.get("prompt").is_some())
}

/// The name to record a Task under: its `description`, which is what the
/// skill asks the model to put the task number in. The title is the same
/// string once the adapter has rendered it, and is the fallback for a patch
/// that carried no `rawInput`.
fn task_name(patch: &ToolPatch) -> Option<String> {
    let described = patch
        .raw_input
        .as_ref()
        .and_then(|input| input.get("description"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string);
    described.or_else(|| {
        patch
            .title
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty() && *text != "Task")
            .map(str::to_string)
    })
}

/// What the Task asked for, kept as the subagent's `task`.
fn task_kind(patch: &ToolPatch) -> String {
    patch
        .raw_input
        .as_ref()
        .and_then(|input| input.get("subagent_type"))
        .and_then(Value::as_str)
        .unwrap_or("general-purpose")
        .to_string()
}

/// Translates a tool-call patch into the subagent event the projection
/// already reduces, or `None` when it is not a subagent.
///
/// `model` is the session's, because that is the only model anything reports;
/// `at_unix_ms` is the arrival time, since the adapter timestamps nothing.
pub fn subagent_event(patch: &ToolPatch, model: Option<&str>, at_unix_ms: u64) -> Option<RuntimeEvent> {
    if !is_task_call(patch) {
        return None;
    }
    let id = patch.tool_call_id.clone()?;
    let name = task_name(patch)?;
    let (status, outcome, finished) = match patch.status.as_deref() {
        // A tool call with no status yet has been announced and not started.
        None | Some("pending") => (SubagentStatus::Starting, None, None),
        Some("in_progress") => (SubagentStatus::Working, None, None),
        Some("completed") => (SubagentStatus::Idle, Some(GenerationOutcome::Success), Some(at_unix_ms)),
        Some("failed") => (SubagentStatus::Idle, Some(GenerationOutcome::Failed), Some(at_unix_ms)),
        // An unknown status is not a reason to lose the node; it is working
        // until something says otherwise.
        Some(_) => (SubagentStatus::Working, None, None),
    };
    Some(RuntimeEvent::SubagentStateChanged {
        id,
        name,
        status,
        outcome,
        // One Task call is one run; generations would count re-runs of a
        // long-lived subagent, which has no counterpart here.
        generation: 1,
        task: task_kind(patch),
        parent_id: None,
        parent_name: None,
        harness: HARNESS.to_string(),
        model: model.map(str::to_string),
        created_at_unix_ms: at_unix_ms,
        generation_started_at_unix_ms: at_unix_ms,
        generation_finished_at_unix_ms: finished,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn patch(name: &str, status: Option<&str>, input: Value) -> ToolPatch {
        let object = json!({
            "toolCallId": "toolu_1",
            "title": "7.3-pricing",
            "status": status,
            "kind": "think",
            "name": name,
            "rawInput": input,
        });
        ToolPatch::from_object(object.as_object().unwrap())
    }

    #[test]
    fn a_task_call_becomes_the_subagent_event_the_projection_already_reduces() {
        let event = subagent_event(
            &patch("Task", Some("in_progress"), json!({ "description": "7.3-pricing", "subagent_type": "general-purpose", "prompt": "…" })),
            Some("sonnet"),
            1_700_000_000_000,
        )
        .expect("a subagent");
        let RuntimeEvent::SubagentStateChanged { id, name, status, harness, model, task, .. } = event else {
            panic!("expected a subagent state change");
        };
        // The name is the Task's description, which is where the skill puts
        // the task number that ties the row to the plan.
        assert_eq!(name, "7.3-pricing");
        assert_eq!(id, "toolu_1");
        assert_eq!(status, SubagentStatus::Working);
        assert_eq!(harness, HARNESS);
        assert_eq!(model.as_deref(), Some("sonnet"));
        assert_eq!(task, "general-purpose");
    }

    #[test]
    fn a_finished_task_reports_its_outcome_and_an_ordinary_tool_is_not_a_subagent() {
        let done = subagent_event(&patch("Task", Some("completed"), json!({ "description": "7.3-pricing", "subagent_type": "x", "prompt": "…" })), None, 7);
        assert!(matches!(
            done,
            Some(RuntimeEvent::SubagentStateChanged { status: SubagentStatus::Idle, outcome: Some(GenerationOutcome::Success), generation_finished_at_unix_ms: Some(7), .. })
        ));
        let failed = subagent_event(&patch("Agent", Some("failed"), json!({ "description": "7.4-x", "subagent_type": "x", "prompt": "…" })), None, 7);
        assert!(matches!(failed, Some(RuntimeEvent::SubagentStateChanged { outcome: Some(GenerationOutcome::Failed), .. })));

        assert_eq!(subagent_event(&patch("Bash", Some("in_progress"), json!({ "command": "ls" })), None, 1), None);
        // A Task the model gave no description is not named after anything,
        // and a row with no name ties to no task; better absent than invented.
        assert_eq!(
            subagent_event(&ToolPatch::from_object(json!({"toolCallId": "t2", "name": "Task", "status": "in_progress", "title": "Task"}).as_object().unwrap()), None, 1),
            None
        );
    }

    #[test]
    fn a_later_patch_that_carries_only_a_status_still_names_the_subagent() {
        // The adapter sends `tool_call` with the input and `tool_call_update`
        // with the status; the actor merges them before this sees them, so
        // the merged patch is what has to work. A title-only merge is the
        // fallback when the input was dropped.
        let merged = ToolPatch::from_object(
            json!({ "toolCallId": "toolu_9", "name": "Task", "status": "completed", "title": "7.5-migrate" }).as_object().unwrap(),
        );
        let event = subagent_event(&merged, Some("opus"), 3).expect("a subagent");
        let RuntimeEvent::SubagentStateChanged { name, .. } = event else { panic!() };
        assert_eq!(name, "7.5-migrate");
    }
}
