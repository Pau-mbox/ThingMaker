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
    flow::Finished,
    host::EngineEvent,
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
        odyssey::{CheckKind, JournalKind, MilestoneState, OdysseyRecord, OdysseyState, OnPlanChange, StepKind},
    },
};

const BIGTHING_INSTRUCTIONS: &str = "When this session runs a Big Thing goal, report to it with the `bigthing_*` tools: `bigthing_report` when a milestone is finished or blocked, `bigthing_task` as tasks move, `bigthing_ask` for a decision only the user can make, `bigthing_amend` to change the plan. \
When the user asks you to use a document (a plan, a spec, a Markdown file you are to write) in Big Thing, or to run it as a Big Thing, do not do the work yourself: write the document, then call `bigthing_load_document` with its path, which loads it into this session's Big Thing tab, and tell the user to open that tab to finish setting the goal up and start it. Big Thing plans and runs the work from there. \
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
            "description": "Every milestone of this session's Big Thing run with its tasks: state, who has each task, and what it waits for.",
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
            "depends": { "type": "array", "items": { "type": "integer", "minimum": 1 }, "description": "Numbers of earlier tasks in the same milestone this one cannot start without. Only real dependencies: tasks without any run in parallel." },
            "capability": { "type": "string", "description": "What the task needs from a worker: image, review, fast, code." },
            "uses": { "type": "array", "items": { "type": "integer", "minimum": 1 }, "description": "Numbers of earlier tasks in the same milestone whose results this one is given, written into its task." },
            "by": { "type": "string", "enum": ["you", "team"], "description": "`you` when this task is the user's own approval: the run stops there and asks them to approve, send the work back, or stop." },
            "repeatFrom": { "type": "integer", "minimum": 1, "description": "An earlier task in the same milestone to send the work back to when this task asks for changes (a review, a test pass, the user's approval). The tasks between run again, with what was asked." },
            "maxRounds": { "type": "integer", "minimum": 1, "description": "How many rounds that loop may take before the user is asked. Leave it out for no limit." }
        },
        "required": ["title"]
    });
    vec![
        json!({
            "name": "bigthing_report",
            "title": "Report a milestone",
            "description": "Tells Big Thing a milestone is finished (status `complete`) or cannot be finished (`blocked`, with why). Send it as soon as that milestone's work is done — in the middle of a long turn too, before moving on to the next one: Big Thing records it at once. A completion is a claim: the milestone's check decides, and Big Thing reads its exit code from your tool results or runs it.",
            "inputSchema": object(json!({
                "milestone": { "type": "integer", "minimum": 1 },
                "status": { "type": "string", "enum": ["complete", "blocked"] },
                "note": { "type": "string", "description": "One line: what was done, or what is in the way." }
            }), &["milestone", "status"]),
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false }
        }),
        json!({
            "name": "bigthing_task",
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
            "name": "bigthing_ask",
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
            "name": "bigthing_propose_plan",
            "title": "Propose a plan",
            "description": "Sends the milestones for a goal that has none yet, when Big Thing asked you to plan from a document. Each milestone carries the document's substance in `detail`, a check Big Thing can run when there is one, and tasks sized in AI-agent time (about 10–30 minutes of agent work each, never human-effort estimates), cut so that independent ones can run in parallel. The user reviews the plan before the run starts.",
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
            "name": "bigthing_amend",
            "title": "Change the plan",
            "description": "Changes the plan when it no longer fits what you found. `ops` is a list of operations, each with `op`: `add` (title, after: a milestone number or \"end\", detail, section, checkKind, checkSpec, steps), `revise` (target, title, detail, section, checkKind, checkSpec, steps to add), `drop` (target, reason), `drop_task` (ref {milestone, task}, reason), `revise_task` (ref, title, detail, depends, uses, by, repeatFrom, maxRounds), `split_task` (ref, steps, reason) and `move_task` (ref, after: a task number or \"start\"). Numbers are as the plan shows them now. Verified milestones and done tasks are not rewritten. Size new tasks in AI-agent time: about 10–30 minutes of agent work each, never human-effort estimates; split anything bigger.",
            "inputSchema": object(json!({
                "ops": { "type": "array", "items": { "type": "object", "properties": { "op": { "type": "string", "enum": ["add", "revise", "drop", "drop_task", "revise_task", "split_task", "move_task"] } }, "required": ["op"] } },
                "reason": { "type": "string" }
            }), &["ops"]),
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false }
        }),
        json!({
            "name": "bigthing_load_document",
            "title": "Load a document into Big Thing",
            "description": "Loads a Markdown or text document into this session's Big Thing tab, where the user sets up a goal from it (or adds it to the goal already running) and starts it. Use it when the user asks for a document to be used in, run by or handed to Big Thing: write the document first, then call this, then tell the user to open the Big Thing tab. Do not start the document's work yourself; Big Thing plans and runs it.",
            "inputSchema": object(json!({
                "path": { "type": "string", "description": "The document, absolute or relative to the workspace: .md, .markdown, .mdx or .txt." }
            }), &["path"]),
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false }
        }),
    ]
}

/// The tool a nested fork reports back with.
fn fork_tools() -> Vec<Value> {
    vec![json!({
        "name": "report_to_parent",
        "title": "Report back to the parent session",
        "description": "This session is a fork nested under the session it was copied from. Sends that session what it should know: a finding, a decision, what is done or in the way. It is context for its next message, not a request, so it never starts work there. Your final answer at the end of each turn is passed on as well; use this for something worth saying on its own, or mid-turn. Keep it short and self-contained.",
        "inputSchema": object(json!({ "report": { "type": "string", "description": "What the parent session should know, in a few sentences." } }), &["report"]),
        "annotations": { "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false }
    })]
}

const FORK_INSTRUCTIONS: &str = "This session is a fork, nested under the session it was copied from (its parent). Your final answer at the end of each turn is passed to the parent as context for its next message; `report_to_parent` sends it something on its own. Neither starts work there.";

/// The largest document Big Thing reads as a plan, as the tab's own import.
const MAX_DOCUMENT_BYTES: u64 = 1024 * 1024;

/// A document the caller names, checked the way the Big Thing tab reads one.
fn plan_document(root: &std::path::Path, path: &str) -> Result<std::path::PathBuf, String> {
    let named = std::path::Path::new(path);
    let path = if named.is_absolute() { named.to_path_buf() } else { root.join(named) };
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    if !matches!(extension.as_str(), "md" | "markdown" | "mdx" | "txt") {
        return Err("Big Thing reads a Markdown or text file (.md, .markdown, .mdx, .txt).".into());
    }
    let metadata = std::fs::metadata(&path).map_err(|error| format!("Could not read {}: {error}. Write the document first.", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a file.", path.display()));
    }
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err("The document is larger than 1 MiB; Big Thing will not read it as a plan.".into());
    }
    if metadata.len() == 0 {
        return Err("The document is empty.".into());
    }
    std::fs::canonicalize(&path).map_err(|error| format!("Could not read {}: {error}", path.display()))
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
            if self.nested_agent_id(caller).is_some() {
                tools.extend(fork_tools());
            }
        }
        tools
    }

    fn instructions(&self, caller: &Caller) -> Option<String> {
        if !matches!(caller, Caller::Orchestrator { .. }) {
            return None;
        }
        Some(if self.nested_agent_id(caller).is_some() { format!("{BIGTHING_INSTRUCTIONS} {FORK_INSTRUCTIONS}") } else { BIGTHING_INSTRUCTIONS.to_string() })
    }

    fn call(&self, caller: &Caller, name: &str, arguments: &Value) -> Option<BoxFuture<Value>> {
        let known = ["memory_read", "memory_write", "board", "bigthing_report", "bigthing_task", "bigthing_ask", "bigthing_propose_plan", "bigthing_amend", "bigthing_load_document", "report_to_parent"];
        if !known.contains(&name) {
            return None;
        }
        let engine = self.clone();
        let caller = caller.clone();
        let name = name.to_string();
        let arguments = arguments.clone();
        Some(Box::pin(async move {
            if (name.starts_with("bigthing_") || name == "report_to_parent") && !matches!(caller, Caller::Orchestrator { .. }) {
                return error_result("Only the run's orchestrator reports to Big Thing.");
            }
            match engine.answer_tool(&caller, &name, &arguments) {
                Ok(value) => text_result(&value, false),
                Err(message) => error_result(&message),
            }
        }))
    }
}

impl Engine {
    /// The goal running on the caller's orchestrator session, if any. A side
    /// session answers for its main session's goal.
    fn goal_for_caller(&self, caller: &Caller) -> Option<OdysseyRecord> {
        let own = caller.orchestrator();
        let side_of = self.side_main(own);
        let handle = side_of.as_deref().unwrap_or(own);
        let known = self.inner.session_goal.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(handle).cloned();
        if let Some(goal_id) = known {
            return self.db(|storage| storage.odyssey_get(&goal_id)).ok().flatten();
        }
        let goals = self.db(|storage| storage.odyssey_active()).ok()?;
        let goal = goals.into_iter().find(|goal| goal.session_id.as_deref().and_then(|row| self.inner.host.live(row)).is_some_and(|live| live.handle == handle))?;
        // A held run's session is not watched; it has to be for what this
        // call says to land when the turn ends.
        if side_of.is_none() {
            self.adopt_soon(&goal, handle);
        }
        Some(goal)
    }

    /// The main session, when the caller is a side session of it.
    fn side_caller(&self, caller: &Caller) -> Option<String> {
        matches!(caller, Caller::Orchestrator { .. }).then(|| self.side_main(caller.orchestrator())).flatten()
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
                let entries: Vec<Value> = entries.iter().map(|entry| json!({ "id": entry.id, "kind": entry.kind, "title": entry.title, "body": entry.body, "author": entry.author, "updated": crate::bigthing::clock::iso8601(entry.updated_at) })).collect();
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
                let goal = self.goal_for_caller(caller).ok_or_else(|| "This session is not running a Big Thing goal, so there is no board.".to_string())?;
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
            "bigthing_report" | "bigthing_propose_plan" if self.side_caller(caller).is_some() => Err(
                "This is a side conversation. Milestones are reported, and plans proposed, by the main session that runs the goal. You can change the plan with bigthing_amend, move tasks with bigthing_task, or ask the user with bigthing_ask.".into(),
            ),
            "bigthing_report" => {
                let goal = self.running_goal(caller)?;
                let loaded = self.load(&goal.id).map_err(|error| error.message)?;
                let milestone = number(arguments, "milestone").ok_or("bigthing_report needs a milestone number")?;
                let status = match string(arguments, "status").as_deref() {
                    Some("complete") => ReportStatus::Complete,
                    Some("blocked") => ReportStatus::Blocked,
                    _ => return Err("status is `complete` or `blocked`".into()),
                };
                let Some(record) = loaded.milestones.get(milestone.wrapping_sub(1)) else {
                    return Err(format!("There is no milestone {milestone}; the plan has {}.", loaded.milestones.len()));
                };
                let note = string(arguments, "note").unwrap_or_default();
                let approvals = super::flow::open_approvals(milestone - 1, &record.steps);
                if status == ReportStatus::Complete && !approvals.is_empty() {
                    return Err(format!("Milestone {milestone} waits for the user's approval at task {}; it is not complete before they decide. Carry on with what does not wait on it.", approvals.join(", ")));
                }
                // Every milestone a turn reports counts, however long the
                // turn: one entry per milestone, the latest word winning.
                let report = Report { milestone, status, note: note.clone() };
                self.with_inbox(&goal.id, |inbox| {
                    inbox.reports.retain(|earlier| earlier.milestone != milestone);
                    inbox.reports.push(report);
                });
                // A completion shows at once, so it can be verified while the
                // turn carries on with the next milestone.
                if status == ReportStatus::Complete && !matches!(record.state, MilestoneState::Verified | MilestoneState::Skipped) {
                    let _ = self.db(|storage| storage.milestone_record_report(&record.id, &note));
                    self.journal(&goal.id, JournalKind::Report, Some(&record.id), &format!("Reported milestone {milestone} complete"), Some(&note));
                    self.changed(&goal.id);
                }
                let check = if record.check_kind == CheckKind::Manual { "the user ticks it".to_string() } else { super::prompt::check_label(record.check_kind, record.check_spec.as_deref()) };
                Ok(json!({
                    "recorded": true,
                    "note": match status {
                        ReportStatus::Complete => format!("Milestone {milestone} recorded as complete; it is verified by its {check}. Carry on with the next one."),
                        ReportStatus::Blocked => format!("Milestone {milestone} reported blocked. Big Thing records it when this turn ends."),
                    }
                }))
            }
            "bigthing_task" => {
                let goal = self.running_goal(caller)?;
                let loaded = self.load(&goal.id).map_err(|error| error.message)?;
                let (Some(milestone), Some(task)) = (number(arguments, "milestone"), number(arguments, "task")) else { return Err("bigthing_task needs a milestone and a task number".into()) };
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
                let step = &record.steps[task - 1];
                if step.kind == StepKind::Approval {
                    return Err(format!("Task {milestone}.{task} is the user's approval: Big Thing asks them, and it moves when they decide. Carry on with tasks that do not wait on it."));
                }
                if let Some(agent) = &line.agent {
                    let _ = self.db(|storage| storage.step_assign(&step.id, Some(agent), None, None));
                }
                // A finished task is settled now, once: it may send the work
                // back, which a second reading at the settle would undo.
                if status == TaskStatus::Done {
                    let who = line.agent.clone().unwrap_or_else(|| "the orchestrator".into());
                    let finished = self.task_finished(&goal, &loaded.milestones, milestone - 1, task - 1, Some(&line.note), &line.note, &who);
                    self.changed(&goal.id);
                    if let Some(main) = self.side_caller(caller) {
                        self.tell_main(&main, &format!("Task {milestone}.{task} \"{}\" was marked done from the side transcript{}.", step.title, if line.note.is_empty() { String::new() } else { format!(": {}", line.note) }));
                    }
                    return Ok(match finished {
                        Finished::SentBack => json!({ "recorded": true, "task": format!("{milestone}.{task}"), "status": "sent_back", "note": "Its verdict asked for changes, so the work went back: the tasks of that loop are open again, with what was asked. Do them again before this one." }),
                        Finished::AskedYou => json!({ "recorded": true, "task": format!("{milestone}.{task}"), "status": "waiting_for_user", "note": "Its loop has used its rounds, so Big Thing asked the user what to do. Carry on with tasks that do not wait on it." }),
                        Finished::Stopped => json!({ "recorded": true, "task": format!("{milestone}.{task}"), "status": "stopped", "note": "Its loop has used its rounds and the run stops here." }),
                        Finished::Done => json!({ "recorded": true, "task": format!("{milestone}.{task}"), "status": "done" }),
                    });
                }
                // Applied now as well as at the settle: the board is live.
                let _ = self.db(|storage| storage.step_set_state(&step.id, status.step_state(), Some(&line.note).filter(|note| !note.is_empty()).map(String::as_str)));
                if let Some(main) = self.side_caller(caller) {
                    self.tell_main(&main, &format!("Task {milestone}.{task} \"{}\" was marked {}{}.", step.title, string(arguments, "status").unwrap_or_default().replace('_', " "), if line.note.is_empty() { String::new() } else { format!(": {}", line.note) }));
                    self.changed(&goal.id);
                    return Ok(json!({ "recorded": true, "task": format!("{milestone}.{task}"), "status": string(arguments, "status"), "note": "Applied now. The main session is told." }));
                }
                self.with_inbox(&goal.id, |inbox| inbox.tasks.push(line));
                self.changed(&goal.id);
                Ok(json!({ "recorded": true, "task": format!("{milestone}.{task}"), "status": string(arguments, "status") }))
            }
            "bigthing_ask" => {
                let goal = self.running_goal(caller)?;
                let question = string(arguments, "question").ok_or("bigthing_ask needs a question")?;
                let options = arguments.get("options").and_then(Value::as_array).map(|options| options.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
                let ask = Ask { kind: ask_kind(string(arguments, "kind").as_deref()), fallback: string(arguments, "default").unwrap_or_default(), options, question };
                if self.side_caller(caller).is_some() {
                    let loaded = self.load(&goal.id).map_err(|error| error.message)?;
                    self.read_asks(&loaded, std::slice::from_ref(&ask));
                    self.changed(&goal.id);
                    return Ok(json!({ "recorded": true, "note": "The user sees it in the Big Thing inbox now." }));
                }
                self.with_inbox(&goal.id, |inbox| inbox.asks.push(ask));
                Ok(json!({ "recorded": true, "note": "The user sees it when this turn ends. Carry on with your default; the answer arrives on a later continuation." }))
            }
            "bigthing_propose_plan" => {
                let goal = self.goal_for_caller(caller).ok_or("This session is not running a Big Thing goal.")?;
                if goal.state != OdysseyState::Draft {
                    return Err("The goal already has a plan and is under way; change it with bigthing_amend.".into());
                }
                let milestones = read_milestones(arguments.get("milestones")).ok_or("milestones must be a list of objects with a title")?;
                let plan = protocol::tidy_plan(milestones).ok_or("The plan has no milestones.")?;
                let count = plan.milestones.len();
                let notes = plan.notes.clone();
                self.with_inbox(&goal.id, |inbox| inbox.plan = Some(plan));
                Ok(json!({ "recorded": true, "milestones": count, "notes": notes, "note": "The user reviews the plan when this turn ends, and starts the run." }))
            }
            "bigthing_amend" => {
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
                if let Some(main) = self.side_caller(caller) {
                    // A side conversation has no turn of the run's to wait
                    // for: the change is applied (or put to the user) now, and
                    // the session doing the work is told.
                    self.apply_amendment(&goal, Amendment { ops, notes: Vec::new() });
                    self.tell_main(&main, &format!("The Big Thing plan was {} from the side transcript: {}", if held { "proposed for a change (waiting for the user's decision)" } else { "changed" }, diff.replace('\n', "; ")));
                    self.changed(&goal.id);
                    return Ok(json!({
                        "recorded": true,
                        "diff": diff,
                        "note": if held { "Changes to what a milestone is wait for the user in the Big Thing inbox; the rest is applied now. The main session is told." } else { "Applied now. The main session is told." }
                    }));
                }
                self.with_inbox(&goal.id, |inbox| inbox.amendment = Some(Amendment { ops, notes: Vec::new() }));
                Ok(json!({
                    "recorded": true,
                    "diff": diff,
                    "note": if held { "Applied when this turn ends where it is yours to change; changes to what a milestone is wait for the user. Work to the plan as it stands until you hear." } else { "Applied when this turn ends." }
                }))
            }
            "report_to_parent" => {
                let report = string(arguments, "report").ok_or("report_to_parent needs a report")?;
                let fork = self.nested_agent_id(caller).ok_or("This session is not nested under another one, so there is no parent to report to.")?;
                let parent = self.report_to_parent(&fork, &report)?;
                Ok(json!({ "reported": true, "note": format!("\"{parent}\" gets it with its next message, as context. Carry on.") }))
            }
            "bigthing_load_document" => {
                let path = string(arguments, "path").ok_or("bigthing_load_document needs the document's path")?;
                let path = plan_document(caller.root(), &path)?;
                // A side conversation loads it into its main session's tab.
                let handle = self.side_caller(caller).unwrap_or_else(|| caller.orchestrator().to_string());
                let running = self.goal_for_caller(caller).filter(|goal| !matches!(goal.state, OdysseyState::Complete | OdysseyState::Abandoned));
                self.inner.host.emit(EngineEvent::DocumentLoaded { handle, path: path.to_string_lossy().into_owned() });
                Ok(json!({
                    "loaded": true,
                    "path": path.to_string_lossy(),
                    "note": match running {
                        Some(goal) => format!("The document is in the Big Thing tab, as new work to add to the goal \"{}\". Tell the user to open the Big Thing tab to review the change and add it. Do not start that work yourself.", goal.title),
                        None => "The document is in the Big Thing tab, ready to set up a goal from. Stop here: tell the user to open the Big Thing tab to finish the setup (title, team, checks) and start it. Do not start the document's work yourself; Big Thing plans and runs it.".to_string(),
                    }
                }))
            }
            other => Err(format!("unknown tool {other}")),
        }
    }

    /// The agent's id for the caller's session, when it is a nested fork.
    fn nested_agent_id(&self, caller: &Caller) -> Option<String> {
        let live = self.inner.host.live_handle(caller.orchestrator())?;
        self.db(|storage| storage.nested_parent(&live.agent_session_id)).ok().flatten().map(|_| live.agent_session_id)
    }

    fn running_goal(&self, caller: &Caller) -> Result<OdysseyRecord, String> {
        let goal = self.goal_for_caller(caller).ok_or("This session is not running a Big Thing goal.")?;
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
                            uses: step.get("uses").and_then(Value::as_array).map(|uses| uses.iter().filter_map(Value::as_u64).map(|n| n as usize).collect()).unwrap_or_default(),
                            by: step.get("by").and_then(Value::as_str).map(str::to_string),
                            repeat_from: step.get("repeatFrom").and_then(Value::as_u64).map(|n| n as usize),
                            max_rounds: step.get("maxRounds").and_then(Value::as_i64),
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
            assert!(BIGTHING_INSTRUCTIONS.contains(name.as_str()) || name == "bigthing_propose_plan", "{name} is named in the instructions");
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
        assert_eq!(plan.milestones[0].steps[1], ProposedTask { title: "b".into(), depends: vec![1], capability: Some("image".into()), ..ProposedTask::default() });
        assert_eq!((plan.milestones[1].check_kind, plan.milestones[1].check_spec.as_deref()), (CheckKind::Command, Some("make check")));
        assert!(read_milestones(Some(&json!([{ "detail": "no title" }]))).is_none());
    }
}
