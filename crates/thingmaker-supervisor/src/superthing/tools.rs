//! The run protocol and the shared memory as `team` tools (ADR-010).
//!
//! Each call is checked against the record when it is made, so a report on a
//! milestone that does not exist is refused in the tool's own answer rather
//! than discovered after the turn. What a call says is kept for the turn and
//! applied when the turn settles, exactly as the text lines are; a tool call
//! wins over a line in the prose, which may be a quote.
//!
//! Workers get a reduced set: the project memory and the run's board.

use serde_json::{Value, json};

use super::{
    engine::{Engine, team_of},
    protocol::{self, Amendment, Ask, ProposedMilestone, ProposedTask, Report, ReportStatus, TaskLine, TaskStatus, TurnProtocol, ask_kind},
};
use crate::{
    delegation::{
        Caller, TeamExtension,
        jobs::BoxFuture,
        mcp::{error_result, text_result},
    },
    storage::{
        memory::{MEMORY_KINDS, MemoryWrite},
        odyssey::{CheckKind, OdysseyRecord, OdysseyState, OnPlanChange},
    },
};

const SUPERTHING_INSTRUCTIONS: &str = "When this session runs a Super Thing goal, report to it with the `superthing_*` tools: `superthing_report` when a milestone is finished or blocked, `superthing_task` as tasks move, `superthing_ask` for a decision only the user can make, `superthing_amend` to change the plan. \
`memory_read` and `memory_write` are the project's shared memory, which every session and worker reads; `board` is the run's task board.";

fn object(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false })
}

fn memory_tools() -> Vec<Value> {
    vec![
        json!({
            "name": "memory_read",
            "title": "Read the project memory",
            "description": "The project's shared memory: decisions, conventions, facts, todos and warnings that the orchestrator, its workers and the user wrote down. Read it before deciding something the project may already have decided. With `query`, only entries containing every word.",
            "inputSchema": object(json!({ "query": { "type": "string" } }), &[]),
            "annotations": { "readOnlyHint": true, "openWorldHint": false }
        }),
        json!({
            "name": "memory_write",
            "title": "Write to the project memory",
            "description": "Records a decision, convention, fact, todo or warning the rest of the team will need — the next session, another worker, the user. Short title, the substance in `body`. Pass `id` to replace an entry that is no longer true.",
            "inputSchema": object(json!({
                "kind": { "type": "string", "enum": MEMORY_KINDS },
                "title": { "type": "string" },
                "body": { "type": "string" },
                "id": { "type": "string", "description": "An entry to replace." }
            }), &["kind", "title"]),
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false }
        }),
        json!({
            "name": "board",
            "title": "The run's task board",
            "description": "Every milestone of this session's Super Thing run with its tasks: state, who has each task, and what it waits for.",
            "inputSchema": object(json!({}), &[]),
            "annotations": { "readOnlyHint": true, "openWorldHint": false }
        }),
    ]
}

fn run_tools() -> Vec<Value> {
    let check = json!({
        "type": "object",
        "properties": {
            "kind": { "type": "string", "enum": ["manual", "command", "tests_pass", "files_exist"] },
            "spec": { "type": "string", "description": "The command that must exit 0, or the paths that must exist, one per line." }
        },
        "required": ["kind"]
    });
    let task = json!({
        "type": "object",
        "properties": {
            "title": { "type": "string" },
            "depends": { "type": "array", "items": { "type": "integer", "minimum": 1 }, "description": "Numbers of earlier tasks in the same milestone this one waits for." },
            "capability": { "type": "string", "description": "What the task needs from a worker: image, review, fast, code." }
        },
        "required": ["title"]
    });
    vec![
        json!({
            "name": "superthing_report",
            "title": "Report a milestone",
            "description": "Tells Super Thing a milestone is finished (status `complete`) or cannot be finished (`blocked`, with why). A completion is a claim: the milestone's check decides, and Super Thing reads its exit code from your tool results or runs it. Send it when the work is done, not while you are still working.",
            "inputSchema": object(json!({
                "milestone": { "type": "integer", "minimum": 1 },
                "status": { "type": "string", "enum": ["complete", "blocked"] },
                "note": { "type": "string", "description": "One line: what was done, or what is in the way." }
            }), &["milestone", "status"]),
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false }
        }),
        json!({
            "name": "superthing_task",
            "title": "Move a task",
            "description": "Moves a task of the plan (milestone 6, task 3 is 6.3): `in_progress` when it starts, `done`, or `blocked`. Name the subagent or worker doing it in `agent` so the run shows who did what.",
            "inputSchema": object(json!({
                "milestone": { "type": "integer", "minimum": 1 },
                "task": { "type": "integer", "minimum": 1 },
                "status": { "type": "string", "enum": ["in_progress", "done", "blocked"] },
                "agent": { "type": "string" },
                "note": { "type": "string" }
            }), &["milestone", "task", "status"]),
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false }
        }),
        json!({
            "name": "superthing_ask",
            "title": "Ask the user",
            "description": "Hands the user a decision only a human can make: an ambiguous requirement, an architectural fork, conflicting constraints, a failure that keeps recurring, a permission you cannot grant yourself. Say what you do meanwhile in `default`, and carry on: the answer arrives on a later continuation.",
            "inputSchema": object(json!({
                "question": { "type": "string" },
                "kind": { "type": "string", "enum": protocol::ASK_KINDS },
                "default": { "type": "string", "description": "What you do until you hear back." },
                "options": { "type": "array", "items": { "type": "string" } }
            }), &["question", "default"]),
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false }
        }),
        json!({
            "name": "superthing_propose_plan",
            "title": "Propose a plan",
            "description": "Sends the milestones for a goal that has none yet, when Super Thing asked you to plan from a document. Each milestone carries the document's substance in `detail`, a check Super Thing can run when there is one, and three to eight tasks. The user reviews the plan before the run starts.",
            "inputSchema": object(json!({
                "milestones": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": { "type": "string" },
                            "detail": { "type": "string" },
                            "section": { "type": "string", "description": "The heading or line range of the document it comes from." },
                            "check": check,
                            "steps": { "type": "array", "items": task }
                        },
                        "required": ["title"]
                    }
                }
            }), &["milestones"]),
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false }
        }),
        json!({
            "name": "superthing_amend",
            "title": "Change the plan",
            "description": "Changes the plan when it no longer fits what you found. `ops` is a list of operations, each with `op`: `add` (title, after: a milestone number or \"end\", detail, section, checkKind, checkSpec, steps), `revise` (target, title, detail, section, checkKind, checkSpec, steps to add), `drop` (target, reason), `drop_task` (ref {milestone, task}, reason), `revise_task` (ref, title, detail, depends), `split_task` (ref, steps, reason) and `move_task` (ref, after: a task number or \"start\"). Numbers are as the plan shows them now. Verified milestones and done tasks are not rewritten.",
            "inputSchema": object(json!({
                "ops": { "type": "array", "items": { "type": "object", "properties": { "op": { "type": "string", "enum": ["add", "revise", "drop", "drop_task", "revise_task", "split_task", "move_task"] } }, "required": ["op"] } },
                "reason": { "type": "string" }
            }), &["ops"]),
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false }
        }),
    ]
}

fn string(arguments: &Value, key: &str) -> Option<String> {
    arguments.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
}

fn number(arguments: &Value, key: &str) -> Option<usize> {
    arguments.get(key).and_then(Value::as_u64).map(|value| value as usize)
}

impl TeamExtension for Engine {
    fn tools(&self, caller: &Caller) -> Vec<Value> {
        let mut tools = memory_tools();
        if matches!(caller, Caller::Orchestrator { .. }) {
            tools.extend(run_tools());
        }
        tools
    }

    fn instructions(&self, caller: &Caller) -> Option<String> {
        matches!(caller, Caller::Orchestrator { .. }).then(|| SUPERTHING_INSTRUCTIONS.to_string())
    }

    fn call(&self, caller: &Caller, name: &str, arguments: &Value) -> Option<BoxFuture<Value>> {
        let known = ["memory_read", "memory_write", "board", "superthing_report", "superthing_task", "superthing_ask", "superthing_propose_plan", "superthing_amend"];
        if !known.contains(&name) {
            return None;
        }
        let engine = self.clone();
        let caller = caller.clone();
        let name = name.to_string();
        let arguments = arguments.clone();
        Some(Box::pin(async move {
            if name.starts_with("superthing_") && !matches!(caller, Caller::Orchestrator { .. }) {
                return error_result("Only the run's orchestrator reports to Super Thing.");
            }
            match engine.answer_tool(&caller, &name, &arguments) {
                Ok(value) => text_result(&value, false),
                Err(message) => error_result(&message),
            }
        }))
    }
}

impl Engine {
    /// The goal running on the caller's orchestrator session, if any.
    fn goal_for_caller(&self, caller: &Caller) -> Option<OdysseyRecord> {
        let handle = caller.orchestrator();
        let known = self.inner.session_goal.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(handle).cloned();
        if let Some(goal_id) = known {
            return self.db(|storage| storage.odyssey_get(&goal_id)).ok().flatten();
        }
        let goals = self.db(|storage| storage.odyssey_active()).ok()?;
        goals.into_iter().find(|goal| goal.session_id.as_deref().and_then(|row| self.inner.host.live(row)).is_some_and(|live| live.handle == handle))
    }

    fn workspace_for(&self, caller: &Caller) -> Result<String, String> {
        let root = caller.root().to_string_lossy().into_owned();
        self.db(|storage| storage.workspace_by_root(&root)).ok().flatten().map(|workspace| workspace.id).ok_or_else(|| "This session's workspace is not one ThingMaker knows.".to_string())
    }

    fn with_inbox(&self, goal_id: &str, change: impl FnOnce(&mut TurnProtocol)) {
        let mut inbox = self.inner.inbox.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        change(inbox.entry(goal_id.to_string()).or_default());
    }

    fn answer_tool(&self, caller: &Caller, name: &str, arguments: &Value) -> Result<Value, String> {
        match name {
            "memory_read" => {
                let workspace = self.workspace_for(caller)?;
                let entries = self.db(|storage| storage.memory_list(&workspace, string(arguments, "query").as_deref())).map_err(|error| error.message)?;
                let entries: Vec<Value> = entries.iter().map(|entry| json!({ "id": entry.id, "kind": entry.kind, "title": entry.title, "body": entry.body, "author": entry.author, "updated": crate::superthing::clock::iso8601(entry.updated_at) })).collect();
                Ok(json!({ "entries": entries, "note": if entries.is_empty() { "The project memory has nothing on that yet." } else { "Newest first." } }))
            }
            "memory_write" => {
                let workspace = self.workspace_for(caller)?;
                let write = MemoryWrite { id: string(arguments, "id"), kind: string(arguments, "kind").unwrap_or_default(), title: string(arguments, "title").unwrap_or_default(), body: string(arguments, "body").unwrap_or_default() };
                let goal = self.goal_for_caller(caller);
                let entry = self.db(|storage| storage.memory_write(&workspace, &write, &caller.author(), goal.as_ref().map(|goal| goal.id.as_str()))).map_err(|error| error.message)?;
                if let Some(goal) = goal {
                    self.changed(&goal.id);
                }
                Ok(json!({ "id": entry.id, "written": true, "note": "Every session and worker of this project can read it now." }))
            }
            "board" => {
                let goal = self.goal_for_caller(caller).ok_or_else(|| "This session is not running a Super Thing goal, so there is no board.".to_string())?;
                let loaded = self.load(&goal.id).map_err(|error| error.message)?;
                let milestones: Vec<Value> = loaded
                    .milestones
                    .iter()
                    .enumerate()
                    .map(|(index, milestone)| {
                        json!({
                            "milestone": index + 1,
                            "title": milestone.title,
                            "state": milestone.state.as_str(),
                            "tasks": protocol::task_lines_for(index, &milestone.steps),
                        })
                    })
                    .collect();
                Ok(json!({ "goal": goal.title, "state": goal.state.as_str(), "milestones": milestones }))
            }
            "superthing_report" => {
                let goal = self.running_goal(caller)?;
                let loaded = self.load(&goal.id).map_err(|error| error.message)?;
                let milestone = number(arguments, "milestone").ok_or("superthing_report needs a milestone number")?;
                let status = match string(arguments, "status").as_deref() {
                    Some("complete") => ReportStatus::Complete,
                    Some("blocked") => ReportStatus::Blocked,
                    _ => return Err("status is `complete` or `blocked`".into()),
                };
                let Some(record) = loaded.milestones.get(milestone.wrapping_sub(1)) else {
                    return Err(format!("There is no milestone {milestone}; the plan has {}.", loaded.milestones.len()));
                };
                let note = string(arguments, "note").unwrap_or_default();
                self.with_inbox(&goal.id, |inbox| inbox.report = Some(Report { milestone, status, note }));
                let check = if record.check_kind == CheckKind::Manual { "the user ticks it".to_string() } else { super::prompt::check_label(record.check_kind, record.check_spec.as_deref()) };
                Ok(json!({
                    "recorded": true,
                    "note": match status {
                        ReportStatus::Complete => format!("Milestone {milestone} claimed complete. Super Thing records it when this turn ends; it is verified by its {check}."),
                        ReportStatus::Blocked => format!("Milestone {milestone} reported blocked. Super Thing records it when this turn ends."),
                    }
                }))
            }
            "superthing_task" => {
                let goal = self.running_goal(caller)?;
                let loaded = self.load(&goal.id).map_err(|error| error.message)?;
                let (Some(milestone), Some(task)) = (number(arguments, "milestone"), number(arguments, "task")) else { return Err("superthing_task needs a milestone and a task number".into()) };
                let status = match string(arguments, "status").as_deref() {
                    Some("in_progress") => TaskStatus::InProgress,
                    Some("done") => TaskStatus::Done,
                    Some("blocked") => TaskStatus::Blocked,
                    _ => return Err("status is `in_progress`, `done` or `blocked`".into()),
                };
                let Some(record) = loaded.milestones.get(milestone.wrapping_sub(1)) else { return Err(format!("There is no milestone {milestone}.")) };
                if record.steps.get(task.wrapping_sub(1)).is_none() {
                    return Err(format!("Milestone {milestone} has {} task{}; there is no task {milestone}.{task}.", record.steps.len(), if record.steps.len() == 1 { "" } else { "s" }));
                }
                let line = TaskLine { milestone, task, status, agent: string(arguments, "agent"), note: string(arguments, "note").unwrap_or_default() };
                // Applied now as well as at the settle: the board is live.
                let step = &record.steps[task - 1];
                let _ = self.db(|storage| storage.step_set_state(&step.id, status.step_state(), Some(&line.note).filter(|note| !note.is_empty()).map(String::as_str)));
                if let Some(agent) = &line.agent {
                    let _ = self.db(|storage| storage.step_assign(&step.id, Some(agent), None, None));
                }
                self.with_inbox(&goal.id, |inbox| inbox.tasks.push(line));
                self.changed(&goal.id);
                Ok(json!({ "recorded": true, "task": format!("{milestone}.{task}"), "status": string(arguments, "status") }))
            }
            "superthing_ask" => {
                let goal = self.running_goal(caller)?;
                let question = string(arguments, "question").ok_or("superthing_ask needs a question")?;
                let options = arguments.get("options").and_then(Value::as_array).map(|options| options.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
                let ask = Ask { kind: ask_kind(string(arguments, "kind").as_deref()), fallback: string(arguments, "default").unwrap_or_default(), options, question };
                self.with_inbox(&goal.id, |inbox| inbox.asks.push(ask));
                Ok(json!({ "recorded": true, "note": "The user sees it when this turn ends. Carry on with your default; the answer arrives on a later continuation." }))
            }
            "superthing_propose_plan" => {
                let goal = self.goal_for_caller(caller).ok_or("This session is not running a Super Thing goal.")?;
                if goal.state != OdysseyState::Draft {
                    return Err("The goal already has a plan and is under way; change it with superthing_amend.".into());
                }
                let milestones = read_milestones(arguments.get("milestones")).ok_or("milestones must be a list of objects with a title")?;
                let plan = protocol::tidy_plan(milestones).ok_or("The plan has no milestones.")?;
                let count = plan.milestones.len();
                let notes = plan.notes.clone();
                self.with_inbox(&goal.id, |inbox| inbox.plan = Some(plan));
                Ok(json!({ "recorded": true, "milestones": count, "notes": notes, "note": "The user reviews the plan when this turn ends, and starts the run." }))
            }
            "superthing_amend" => {
                let goal = self.running_goal(caller)?;
                let loaded = self.load(&goal.id).map_err(|error| error.message)?;
                let ops: Vec<protocol::AmendOp> = serde_json::from_value(arguments.get("ops").cloned().unwrap_or(Value::Null)).map_err(|error| format!("ops could not be read: {error}"))?;
                if ops.is_empty() {
                    return Err("ops is empty: say what changes.".into());
                }
                let mut ops = ops;
                if let Some(reason) = string(arguments, "reason") {
                    for op in &mut ops {
                        match op {
                            protocol::AmendOp::Drop { reason: own, .. } | protocol::AmendOp::DropTask { reason: own, .. } | protocol::AmendOp::ReviseTask { reason: own, .. } | protocol::AmendOp::SplitTask { reason: own, .. } | protocol::AmendOp::MoveTask { reason: own, .. } if own.is_empty() => {
                                *own = reason.clone();
                            }
                            _ => {}
                        }
                    }
                }
                let resolved = protocol::resolve_ops(&ops, &loaded.milestones);
                let diff = protocol::diff_text(&protocol::plan_diff(&resolved, &loaded.milestones));
                let held = match goal.on_plan_change {
                    OnPlanChange::Auto => false,
                    OnPlanChange::Review => true,
                    OnPlanChange::TasksAuto => ops.iter().any(protocol::AmendOp::is_milestone_scope),
                };
                self.with_inbox(&goal.id, |inbox| inbox.amendment = Some(Amendment { ops, notes: Vec::new() }));
                Ok(json!({
                    "recorded": true,
                    "diff": diff,
                    "note": if held { "Applied when this turn ends where it is yours to change; changes to what a milestone is wait for the user. Work to the plan as it stands until you hear." } else { "Applied when this turn ends." }
                }))
            }
            other => Err(format!("unknown tool {other}")),
        }
    }

    fn running_goal(&self, caller: &Caller) -> Result<OdysseyRecord, String> {
        let goal = self.goal_for_caller(caller).ok_or("This session is not running a Super Thing goal.")?;
        if matches!(goal.state, OdysseyState::Complete | OdysseyState::Abandoned) {
            return Err(format!("The goal is {}.", goal.state.as_str()));
        }
        Ok(goal)
    }

    /// The team a goal will run with, for the screen.
    pub fn goal_team(&self, goal: &OdysseyRecord) -> Option<crate::delegation::Combo> {
        team_of(goal).map(|team| team.1)
    }
}

/// Milestones as the tool sends them, in the plan's own shape.
fn read_milestones(value: Option<&Value>) -> Option<Vec<ProposedMilestone>> {
    let items = value?.as_array()?;
    let mut out = Vec::new();
    for item in items {
        let title = item.get("title")?.as_str()?.trim().to_string();
        let (check_kind, check_spec) = match item.get("check") {
            Some(Value::Object(check)) => (check.get("kind").and_then(Value::as_str).map(CheckKind::parse).unwrap_or_default(), check.get("spec").and_then(Value::as_str).map(str::to_string)),
            Some(Value::String(text)) => {
                let (kind, spec, _) = protocol::read_check(text);
                (kind, spec)
            }
            _ => (CheckKind::Manual, None),
        };
        let steps = item
            .get("steps")
            .and_then(Value::as_array)
            .map(|steps| {
                steps
                    .iter()
                    .filter_map(|step| match step {
                        Value::String(title) => Some(ProposedTask { title: title.clone(), ..ProposedTask::default() }),
                        Value::Object(step) => Some(ProposedTask {
                            title: step.get("title")?.as_str()?.to_string(),
                            depends: step.get("depends").and_then(Value::as_array).map(|depends| depends.iter().filter_map(Value::as_u64).map(|n| n as usize).collect()).unwrap_or_default(),
                            capability: step.get("capability").and_then(Value::as_str).map(|capability| capability.trim().to_lowercase()).filter(|capability| !capability.is_empty()),
                        }),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.push(ProposedMilestone {
            title,
            detail: item.get("detail").and_then(Value::as_str).unwrap_or("").to_string(),
            section: item.get("section").and_then(Value::as_str).map(str::to_string),
            check_kind,
            check_spec,
            steps,
        });
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_has_an_object_schema_and_workers_get_only_memory_and_the_board() {
        for tool in memory_tools().iter().chain(run_tools().iter()) {
            assert_eq!(tool["inputSchema"]["type"], "object", "{}", tool["name"]);
            assert!(tool["description"].as_str().unwrap().len() > 40);
        }
        let names: Vec<String> = run_tools().iter().map(|tool| tool["name"].as_str().unwrap().to_string()).collect();
        for name in &names {
            assert!(SUPERTHING_INSTRUCTIONS.contains(name.as_str()) || name == "superthing_propose_plan", "{name} is named in the instructions");
        }
    }

    #[test]
    fn a_plan_sent_through_the_tool_reads_like_the_block() {
        let value = json!([
            { "title": "One", "detail": "d", "check": { "kind": "tests_pass", "spec": "cargo test" }, "steps": [{ "title": "a" }, { "title": "b", "depends": [1], "capability": "Image" }] },
            { "title": "Two", "check": "command make check", "steps": ["x"] },
            { "title": "  " }
        ]);
        let plan = protocol::tidy_plan(read_milestones(Some(&value)).unwrap()).unwrap();
        assert_eq!(plan.milestones.len(), 2, "a blank title is dropped");
        assert_eq!(plan.milestones[0].steps[1], ProposedTask { title: "b".into(), depends: vec![1], capability: Some("image".into()) });
        assert_eq!((plan.milestones[1].check_kind, plan.milestones[1].check_spec.as_deref()), (CheckKind::Command, Some("make check")));
        assert!(read_milestones(Some(&json!([{ "detail": "no title" }]))).is_none());
    }
}
