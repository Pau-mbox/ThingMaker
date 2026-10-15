//! The text Big Thing submits to the session.
//!
//! Two kinds, sized deliberately. The briefing goes in once per session, so it
//! is served from the provider's prefix cache from the second turn on; every
//! continuation after it is a pointer plus what changed. Pure: it formats and
//! decides nothing. The briefing is also what the user is shown before a run
//! starts, so the text here is the contract.

use serde::{Deserialize, Serialize};

use super::protocol::{ASK_GRAMMAR, PLAN_GRAMMAR, REPORT_GRAMMAR, TASK_GRAMMAR, task_lines_for};
use crate::agents::Provider;
use crate::delegation::{Combo, jobs::BRIEF_PATH};
use crate::odyssey_notes::{AGENT_NOTES_DIR, STATE_NOTE_PATH, WorkspaceNotes};
use crate::storage::odyssey::{CheckKind, MilestoneRecord, MilestoneState, OdysseyRecord, OnPlanChange, StopCondition};

/// The delegate a Claude orchestrator raises its subagents as.
pub const DELEGATE_NAME: &str = "big-thing-delegate";

/// One thing that changed since the last continuation, told once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Delta {
    Verified { milestone: usize, title: String, evidence: String },
    CheckFailed { milestone: usize, title: String, command: String, exit_code: i64, tail: String },
    PlanEdited { summary: String },
    Resumed { waited_ms: i64, checkpoint_files: Option<i64> },
    Budget { continuations_left: i64 },
    PlanChangePending { summary: String },
    PlanChangeRejected { summary: String, note: Option<String> },
    QuestionAnswered { question: String, answer: Option<String> },
    /// The runner dispatched tasks to workers, and how they ended.
    TasksFinished { lines: Vec<String> },
}

fn duration(ms: i64) -> String {
    let minutes = ((ms as f64) / 60_000.0).round() as i64;
    if minutes < 1 {
        return "under a minute".into();
    }
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    if minutes % 60 > 0 { format!("{hours}h{}m", minutes % 60) } else { format!("{hours}h") }
}

/// Where the run's memory lives, said truthfully: "update it" about a file
/// that is not there teaches the model the prompt is unreliable.
pub fn handoff_line(notes: Option<&WorkspaceNotes>, now: i64) -> String {
    match notes {
        None => format!("Handoff note: `{STATE_NOTE_PATH}` — keep it current: what is done, what is in flight, which files you own, what you learned that the plan does not say."),
        Some(notes) => match &notes.state {
            None => format!("Handoff note: `{STATE_NOTE_PATH}` does not exist yet — create it this turn: what is done, what is in flight, which files you own, what you learned that the plan does not say. Update it before every report."),
            Some(state) => format!(
                "Handoff note: `{}` (updated {} ago) — read it if you have lost the thread, update it before you report.",
                state.path,
                duration((now - state.modified_at_unix_ms as i64).max(0))
            ),
        },
    }
}

/// Subagent notes written after `since`.
pub fn agent_notes_since(notes: Option<&WorkspaceNotes>, since: Option<i64>) -> Vec<String> {
    let Some(notes) = notes else { return Vec::new() };
    notes.agent_notes.iter().filter(|note| since.is_none_or(|since| note.modified_at_unix_ms as i64 > since)).map(|note| note.path.clone()).collect()
}

/// A milestone's check, in words.
pub fn check_label(kind: CheckKind, spec: Option<&str>) -> String {
    match (kind, spec) {
        (CheckKind::Command, Some(spec)) | (CheckKind::TestsPass, Some(spec)) => format!("check: `{spec}` must exit 0"),
        (CheckKind::Command, None) => "check: a command that must exit 0 (not set yet)".into(),
        (CheckKind::TestsPass, None) => "check: a test command that must exit 0 (not set yet)".into(),
        (CheckKind::FilesExist, Some(spec)) => format!("check: these files must exist: {}", spec.split('\n').filter(|line| !line.is_empty()).collect::<Vec<_>>().join(", ")),
        (CheckKind::FilesExist, None) => "check: files that must exist (not set yet)".into(),
        (CheckKind::Manual, _) => "check: the user ticks it".into(),
    }
}

/// What the record holds about a milestone, in the run's words. `reported`
/// is not "done": nothing checked it.
pub fn milestone_state_label(state: MilestoneState) -> &'static str {
    match state {
        MilestoneState::Verified => "done — its check passed; do not redo it",
        MilestoneState::Reported => "claimed done by the previous session, never verified",
        MilestoneState::Active => "in flight when the run moved",
        MilestoneState::Failed => "reported blocked",
        MilestoneState::Skipped => "skipped",
        MilestoneState::Planned => "not started",
    }
}

/// What the briefing needs besides the goal and its milestones.
#[derive(Debug, Clone, Default)]
pub struct BriefingOptions<'a> {
    pub skill_available: bool,
    pub notes: Option<&'a WorkspaceNotes>,
    pub now: i64,
    /// This session picked the run up from another one.
    pub handed_over: bool,
    pub agent: Option<Provider>,
    pub team: Option<&'a Combo>,
    /// The session has the `team` MCP server, so the protocol is tools.
    pub tools: bool,
    /// The runner hands the plan's tasks to the workers itself.
    pub runner_dispatch: bool,
    /// Entries in the project's shared memory.
    pub memory_entries: usize,
    /// The run's own branch, when it has a worktree.
    pub branch: Option<&'a str>,
}

fn has_workers(team: Option<&Combo>) -> Option<&Combo> {
    team.filter(|team| !team.workers.is_empty())
}

/// Submitted once per session, before the first continuation. It explains the
/// mechanics the model cannot infer.
pub fn build_briefing(goal: &OdysseyRecord, milestones: &[MilestoneRecord], options: &BriefingOptions<'_>) -> String {
    let plan: Vec<String> = milestones
        .iter()
        .enumerate()
        .map(|(index, milestone)| {
            format!(
                "{}. {}{}{}{}  [{}]",
                index + 1,
                milestone.title,
                if milestone.detail.is_empty() { String::new() } else { format!(" — {}", milestone.detail) },
                milestone.section.as_deref().map(|section| format!("  (spec: {section})")).unwrap_or_default(),
                if options.handed_over { format!("  [{}]", milestone_state_label(milestone.state)) } else { String::new() },
                check_label(milestone.check_kind, milestone.check_spec.as_deref())
            )
        })
        .collect();
    let stop = match goal.stop_condition {
        StopCondition::GoalComplete => "Work through every milestone in order.",
        StopCondition::MilestoneComplete => "Stop after each milestone; the user restarts you for the next one.",
        StopCondition::Manual => "The user decides when to stop.",
    };
    let mut lines: Vec<String> = vec!["You are working under Big Thing, ThingMaker's long-horizon runner.".into(), String::new()];
    if options.handed_over {
        lines.push(format!(
            "This session picked up a run another session started, so some of the milestones below may already be done — the record says which. Nothing of that session's conversation came with the goal; `{STATE_NOTE_PATH}` is where it left off, and `{AGENT_NOTES_DIR}/` is what its subagents wrote. Read both before you touch anything, and do not redo work they say is finished."
        ));
        lines.push(String::new());
    }
    lines.push("How this works:".into());
    lines.push("- The goal below is broken into ordered milestones. You work the active one.".into());
    lines.push("- After each of your turns Big Thing takes a checkpoint of the working tree and sends you the next continuation. Do not ask permission to continue and do not wait for a human between milestones.".into());
    lines.push("- Big Thing pauses the run when the account's usage window is spent and resumes it when the provider's quota resets. A long gap between turns is normal and means nothing failed.".into());
    lines.push("- A milestone is done when its check passes, not when you say so. Each check is listed below. You may run it yourself, including from a subagent, and Big Thing reads the exit code out of your tool results.".into());
    if let Some(branch) = options.branch {
        lines.push(format!("- This run has its own Git worktree on branch `{branch}`. Work and commit here only; Big Thing commits a checkpoint after every turn, so never rewrite this branch's history."));
    }
    if options.tools {
        lines.push("- You report to Big Thing through its tools on the `team` server: `bigthing_report` when a milestone is finished or blocked, `bigthing_task` when a task starts, finishes or cannot be done, `bigthing_ask` for a decision only the user can make, and `bigthing_amend` to change the plan. Each call is checked against the plan and answered at once.".into());
        lines.push(format!("- If those tools are ever unavailable, end the reply with a single line instead: {REPORT_GRAMMAR}. While you are still working, report nothing."));
    } else {
        lines.push(format!("- When you finish a milestone, end that reply with a single line: {REPORT_GRAMMAR}. While you are still working, send no report line."));
    }
    if options.skill_available {
        lines.push("- Load the `big-thing` skill if you want the full protocol.".into());
    }
    lines.push(String::new());
    if let Some(path) = goal.plan_path.as_deref() {
        lines.push(format!("- The full specification is at `{path}`. The milestone details below carry its substance, but read the file whenever you need more than they say. A milestone's `spec:` names the part of it to read for that milestone."));
    }
    lines.push(format!("- {}", handoff_line(options.notes, options.now)));
    if options.tools {
        lines.push(format!(
            "- The project has a shared memory the whole team reads and writes: `memory_read` before you decide something the project may already have decided ({} entr{} so far), `memory_write` for a decision, a convention or a fact the next session or a worker will need. `board` shows the run's task board.",
            options.memory_entries,
            if options.memory_entries == 1 { "y" } else { "ies" }
        ));
    }
    lines.extend(delegation_lines(options));
    let plan_change = match goal.on_plan_change {
        OnPlanChange::Auto => "It is applied at once and the user sees the diff.",
        OnPlanChange::Review => "It is shown to the user as a diff and applied when they accept; until then, work to the plan as it stands.",
        OnPlanChange::TasksAuto => "Task changes land at once. Adding or dropping a milestone, or changing its title or check, is shown to the user as a diff and lands when they accept; until then, work to the plan as it stands.",
    };
    if options.tools {
        lines.push(format!("- When the plan no longer fits what you found, change it with `bigthing_amend` — add, revise, drop, split or move tasks and milestones — and give a reason. {plan_change}"));
        lines.push("- Decisions only a human can make — an ambiguous requirement, an architectural fork, constraints that conflict, a failure that keeps recurring, a permission you cannot grant yourself — go to `bigthing_ask`, with what you will do meanwhile. Carry on; never wait for the answer. Everything else you decide.".into());
        lines.push(format!(
            "- Milestones are broken into numbered tasks (6.3 is the third task of milestone 6). Name each {} after its task, `6.3-<slug>`, so the run can show which model did it, and move tasks with `bigthing_task`.",
            if has_workers(options.team).is_some() { "delegated job (the start of its task text)" } else { "subagent" }
        ));
    } else {
        lines.push(format!("- When the plan no longer fits what you found, change it with a BIGTHING-AMEND block — add, revise, drop, split or move tasks and milestones — and give a `reason:`. {plan_change}"));
        lines.push(format!("- Decisions only a human can make — an ambiguous requirement, an architectural fork, constraints that conflict, a failure that keeps recurring, a permission you cannot grant yourself — go on one line: {ASK_GRAMMAR}. Name what you will do meanwhile and carry on; never wait for the answer. Everything else you decide."));
        lines.push(format!(
            "- Milestones are broken into numbered tasks (6.3 is the third task of milestone 6). Name each {} after its task, `6.3-<slug>`, so the run can show which model did it, and when a task starts, finishes or cannot be done, put a line in your reply: {TASK_GRAMMAR}. Several lines per reply are fine.",
            if has_workers(options.team).is_some() { "delegated job (the start of its task text)" } else { "subagent" }
        ));
    }
    lines.push(String::new());
    lines.push(format!("Goal: {}", goal.title));
    if !goal.brief.is_empty() {
        lines.push(goal.brief.clone());
    }
    lines.push(String::new());
    lines.push(if milestones.is_empty() { "Milestones: none yet; ask the user for them before starting work.".into() } else { "Milestones:".into() });
    lines.extend(plan);
    lines.push(String::new());
    lines.push(stop.into());
    lines.push(format!(
        "Budget: at most {} continuations{}. Big Thing stops the run at the ceiling, so keep turns purposeful.",
        goal.max_continuations,
        goal.token_budget.map(|budget| format!(", and {} tokens", super::decide::grouped(budget))).unwrap_or_default()
    ));
    lines.join("\n")
}

/// How the run delegates, which depends on who can do the work.
fn delegation_lines(options: &BriefingOptions<'_>) -> Vec<String> {
    let notes = format!("`{AGENT_NOTES_DIR}/<name>.md`");
    let mut lines = Vec::new();
    let team = has_workers(options.team);
    let native = team.is_none_or(|team| team.native_subagents);
    if let Some(team) = team {
        let roster = team
            .workers
            .iter()
            .map(|worker| {
                format!(
                    "{} ({}{}{})",
                    worker.name,
                    worker.provider.label(),
                    worker.model.as_deref().map(|model| format!(" · {model}")).unwrap_or_default(),
                    if worker.capabilities.is_empty() { String::new() } else { format!("; {}", worker.capabilities.join(", ")) }
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        if options.runner_dispatch {
            lines.push(format!("- You lead a team: {roster}. Big Thing hands the milestone's ready tasks to these workers itself, in parallel, and tells you when they are done; you plan, read their results, verify and report. Do not delegate a task Big Thing has already given a worker. Use `delegate` only for follow-up work the plan does not list."));
        } else {
            lines.push(format!("- You lead a team: {roster}. Hand routine implementation to its workers with the `team` tools — `delegate` by worker name or capability, then `await_jobs` for their reports; call `list_workers` if the team may have changed. Delegate independent tasks together and keep every worker busy: `await_jobs` returns when any one job finishes, so give that worker the next ready task straight away, across milestones when the current one has nothing ready, rather than waiting for the whole batch."));
        }
        lines.push(format!("- Before your first delegation, write `{BRIEF_PATH}` and keep it current: what the project is, its layout and key files, conventions, how to build and how to run one targeted test — under 80 lines. ThingMaker attaches it to every task a worker gets, so workers start without re-reading the codebase. Workers check their own change narrowly; the full build, test suite and smoke tests are the milestone's check, run once."));
        lines.push(format!("- A worker sees only the task it is given. Start each task with its plan number and a short name (`6.3-pricing: …`), include the milestone's spec reference and the handoff note's path, and tell it to write its result to {notes} before it finishes."));
        lines.push(if native { "- You may also raise your own subagents for work inside this session.".into() } else { "- Your own subagent tool is turned off for this run: every delegated task goes to a worker.".into() });
    }
    if native {
        lines.push(format!("- Every subagent you raise writes its result to {notes} before it returns, gets the handoff note, `{BRIEF_PATH}` and the milestone's spec reference in its prompt, and checks its own change narrowly rather than running the full build or test suite."));
        if options.agent == Some(Provider::Claude) {
            lines.push(format!("- Raise every subagent with `subagent_type: {DELEGATE_NAME}`, which this project defines. It pins the model the run is meant to delegate on; the default subagent type does not."));
        }
    }
    lines.push(format!("- When a turn is resumed or restarted, read `{AGENT_NOTES_DIR}/` before delegating anything again: a worker or subagent that stopped at a quota wall may have finished on disk."));
    lines.push(format!(
        "- Plan, delegate, read results and report. Run the shell yourself to verify a delegate's claim or the milestone's check; routine implementation belongs in {}.",
        if team.is_some() { "a worker" } else { "a subagent" }
    ));
    lines
}

fn delta_line(delta: &Delta) -> String {
    match delta {
        Delta::Verified { milestone, evidence, .. } => format!("- Milestone {milestone} verified ({evidence})."),
        Delta::CheckFailed { milestone, command, exit_code, tail, .. } => {
            format!("- Milestone {milestone} check failed: `{command}` exited {exit_code}.{}", if tail.is_empty() { String::new() } else { format!(" Tail: {tail}") })
        }
        Delta::PlanEdited { summary } => format!("- Plan edited: {summary}"),
        Delta::Resumed { waited_ms, checkpoint_files } => format!(
            "- Resumed after waiting {} for the usage window{}.",
            duration(*waited_ms),
            checkpoint_files.map(|files| format!("; the last checkpoint was {files} file{}", if files == 1 { "" } else { "s" })).unwrap_or_default()
        ),
        Delta::Budget { continuations_left } => format!("- {continuations_left} continuation{} left in the budget.", if *continuations_left == 1 { "" } else { "s" }),
        Delta::PlanChangePending { summary } => format!("- Your plan change is waiting for the user's decision; the plan below is unchanged until then, so work to it and do not send the change again: {summary}"),
        Delta::PlanChangeRejected { summary, note } => {
            format!("- The user rejected your plan change ({summary}){} Work to the plan as it stands.", note.as_deref().map(|note| format!(": {note}")).unwrap_or_else(|| ".".into()))
        }
        Delta::QuestionAnswered { question, answer } => match answer {
            Some(answer) => format!("- You asked \"{question}\". The user answered: {answer}"),
            None => format!("- You asked \"{question}\". The user dismissed it without an answer: keep your default."),
        },
        Delta::TasksFinished { lines } => format!("- The workers finished their tasks:\n{}", lines.iter().map(|line| format!("  {line}")).collect::<Vec<_>>().join("\n")),
    }
}

/// What a continuation needs.
#[derive(Debug, Clone)]
pub struct ContinuationInput<'a> {
    pub milestone: &'a MilestoneRecord,
    pub index: usize,
    pub total: usize,
    pub deltas: &'a [Delta],
    pub plan_path: Option<&'a str>,
    pub notes: Option<Option<&'a WorkspaceNotes>>,
    pub agent_notes: &'a [String],
    pub now: i64,
    pub tools: bool,
    /// Big Thing hands the ready tasks out itself, so the orchestrator is not
    /// told to.
    pub runner_dispatch: bool,
    /// Whether the milestone's detail, spec section and check go out. Only
    /// the first continuation of a milestone on a session needs them.
    pub full: bool,
}

/// Submitted after each settled turn: the pointer and the deltas only.
pub fn build_continuation(input: &ContinuationInput<'_>) -> String {
    let milestone = input.milestone;
    let mut lines = vec![format!("Continue. Milestone {}/{}: {}.", input.index + 1, input.total, milestone.title)];
    if input.full {
        if !milestone.detail.is_empty() {
            lines.push(milestone.detail.clone());
        }
        if let Some(section) = milestone.section.as_deref() {
            lines.push(format!("Spec: {section}{}.", input.plan_path.map(|path| format!(" in `{path}`")).unwrap_or_default()));
        }
    }
    if !milestone.steps.is_empty() {
        lines.push("Tasks:".into());
        lines.extend(task_lines_for(input.index, &milestone.steps));
        lines.push(if input.tools { "Move tasks with `bigthing_task`.".into() } else { format!("Report task moves with: {TASK_GRAMMAR}") });
        let ready = super::protocol::ready_tasks(&milestone.steps).len();
        if ready >= 2 && !input.runner_dispatch {
            lines.push(format!("{ready} tasks are ready and wait on nothing: hand them to subagents or workers at the same time rather than one after another, and as each one finishes give its worker the next ready task."));
        }
    }
    if input.full && milestone.check_kind != CheckKind::Manual {
        lines.push(check_label(milestone.check_kind, milestone.check_spec.as_deref()).replacen("check: ", "Its check: ", 1));
    }
    if let Some(notes) = input.notes {
        lines.push(handoff_line(notes, input.now));
    }
    if !input.agent_notes.is_empty() {
        lines.push(format!(
            "Subagent notes written since your last turn: {}. Read them before raising any of that work again.",
            input.agent_notes.iter().map(|path| format!("`{path}`")).collect::<Vec<_>>().join(", ")
        ));
    }
    if !input.deltas.is_empty() {
        lines.push(String::new());
        lines.extend(input.deltas.iter().map(delta_line));
    }
    lines.join("\n")
}

/// The planning prompt: the document, and what to turn it into.
pub fn build_planning_prompt(goal: &OdysseyRecord, document: &str, source: Option<&str>, tools: bool) -> String {
    let check_rule = match goal.default_check.as_deref().map(str::trim).filter(|check| !check.is_empty()) {
        Some(check) => format!("- **Every milestone gets a check Big Thing can run.** The project's test command is `{check}`; use `check: tests_pass {check}` unless the document names a better command for that milestone (`command <cmd>` for something else that must exit 0, `files_exist <paths>` for artefacts). Big Thing runs these commands itself, so do not invent one that is not there. `manual` stalls the run at that milestone until a human ticks it; use it only when nothing can be run."),
        None => "- **Prefer a check Big Thing can run.** If the repository has a test command you can see — a package script, a Makefile target, `cargo test`, a script under `Tools/` — use `tests_pass <cmd>` for milestones whose work it covers, and `command <cmd>` or `files_exist <paths>` where the document names something else that must hold. Big Thing runs these commands itself, so do not invent one. `manual` stalls the run at that milestone until a human ticks it; use it only when nothing can be run.".into(),
    };
    let mut lines = vec![
        "You are setting up a Big Thing goal, ThingMaker's long-horizon runner. This turn is planning only: do not start the work, do not edit any files, and do not run anything.".to_string(),
        String::new(),
        format!("Goal: {}", goal.title),
    ];
    if !goal.brief.is_empty() {
        lines.push(goal.brief.clone());
    }
    lines.extend([
        String::new(),
        format!("Read the {} and turn it into an ordered list of milestones for this goal.", source.map(|source| format!("document below (`{source}`)")).unwrap_or_else(|| "document below".into())),
        String::new(),
        "What makes a good milestone here:".into(),
        "- One reviewable outcome, in the order it has to happen. Between 3 and 12 is usual.".into(),
        "- **Carry the document's substance across, do not summarise it.** A milestone's `detail:` is the working specification for that milestone, and for most of the run it is all anyone sees — the document itself is not re-sent every turn. Move the relevant section into it: the specific names, numbers, formats, ordering rules and constraints, in the document's own words where they are precise. Aim for a few hundred words per milestone rather than a sentence.".into(),
        "- Use several `detail:` lines to keep that structure; they are joined as separate lines.".into(),
        "- Break each milestone into `step:` tasks, each one thing a subagent or worker can be given on its own, and `capability:` when a task needs a particular kind of worker (`image`, `review`, `fast`). The run tracks these tasks — who ran each, and when — so they should be real units of work, not headings.".into(),
        "- **Size every task in AI-agent time, not human time.** A task should take one AI agent about 10–30 minutes of work. Agents write and check code roughly 20 times faster than estimates written for people, so a task a developer would put at half a day to two days is about one task, and anything a developer would call a week is several. Do not think in human hours or days at all; split any task an agent would need more than about 30 minutes for, because one long task holds up everything that waits on it, and the team runs many short tasks side by side.".into(),
        "- **Plan for parallel work.** Tasks without `depends:` can run at the same time, on different subagents or workers, so cut the work along lines that do not touch each other — separate files, modules, screens, assets — rather than as one sequence. Add `depends:` (the numbers of earlier tasks in the same milestone) only when a task truly cannot start until another has finished: it needs that task's output, file or decision. The order you list tasks in is not a dependency, and a task that only *reads* what another touches can usually go in parallel. A final integration, verification or review task is the usual one that depends on the others.".into(),
        "- Name where each milestone came from with `section:` — the document's heading, or a line range — so the agent can read that part of the file rather than all of it.".into(),
        check_rule,
        "- Skip anything the document records as already finished, and say so in that milestone's detail rather than adding it as work.".into(),
        String::new(),
        "Between them, the milestones should cover the document. A reader with only your milestones should be able to build the thing without the document in front of them.".into(),
        String::new(),
    ]);
    if tools {
        lines.push("Send the plan with the `bigthing_propose_plan` tool on the `team` server. If that tool is not available, reply with nothing but this block, in exactly this shape:".into());
    } else {
        lines.push("Reply with nothing but this block, in exactly this shape:".into());
    }
    lines.extend([
        String::new(),
        PLAN_GRAMMAR.to_string(),
        String::new(),
        "Repeat the `milestone:` group once per milestone, in order. If the document is not a plan for this goal, propose nothing and say what you found instead.".into(),
        String::new(),
        source.map(|source| format!("--- {source} ---")).unwrap_or_else(|| "--- document ---".into()),
        document.to_string(),
        source.map(|source| format!("--- end of {source} ---")).unwrap_or_else(|| "--- end of document ---".into()),
    ]);
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delegation::WorkerSlot;
    use crate::odyssey_notes::NoteInfo;
    use crate::storage::odyssey::StepState;
    use crate::bigthing::tests::{goal, milestone, step};

    fn plan() -> Vec<MilestoneRecord> {
        let mut first = milestone("m1", MilestoneState::Verified);
        first.title = "Foundation".into();
        first.check_kind = CheckKind::TestsPass;
        first.check_spec = Some("pnpm test".into());
        let mut second = milestone("m2", MilestoneState::Planned);
        second.title = "Screens".into();
        second.section = Some("## UI".into());
        vec![first, second]
    }

    #[test]
    fn the_briefing_explains_the_mechanics_and_lists_the_plan() {
        let text = build_briefing(&goal(), &plan(), &BriefingOptions { skill_available: true, tools: true, ..Default::default() });
        assert!(text.starts_with("You are working under Big Thing"));
        assert!(text.contains("`bigthing_report`"));
        assert!(text.contains(REPORT_GRAMMAR), "the text line stays as a fallback");
        assert!(text.contains("1. Foundation  [check: `pnpm test` must exit 0]"));
        assert!(text.contains("2. Screens  (spec: ## UI)  [check: the user ticks it]"));
        assert!(text.contains("Budget: at most 50 continuations."));
        assert!(text.contains("`big-thing` skill"));
        let plain = build_briefing(&goal(), &plan(), &BriefingOptions::default());
        assert!(!plain.contains("bigthing_report"), "no tools promised to a session without them");
        assert!(plain.contains(ASK_GRAMMAR) && plain.contains(TASK_GRAMMAR));
        assert!(!plain.contains("skill"));
    }

    #[test]
    fn an_inherited_run_carries_its_milestone_states() {
        let text = build_briefing(&goal(), &plan(), &BriefingOptions { handed_over: true, ..Default::default() });
        assert!(text.contains("picked up a run another session started"));
        assert!(text.contains("[done — its check passed; do not redo it]"));
        assert!(!build_briefing(&goal(), &plan(), &BriefingOptions::default()).contains("picked up"));
    }

    #[test]
    fn a_team_changes_how_the_run_delegates() {
        let team = Combo {
            workers: vec![WorkerSlot { name: "luna".into(), provider: Provider::Codex, model: Some("gpt-6-luna".into()), effort: None, capabilities: vec!["image".into()], note: None }],
            native_subagents: false,
        };
        let text = build_briefing(&goal(), &plan(), &BriefingOptions { team: Some(&team), agent: Some(Provider::Claude), tools: true, ..Default::default() });
        assert!(text.contains("You lead a team: luna (Codex · gpt-6-luna; image)"));
        assert!(text.contains("keep every worker busy") && text.contains("rather than waiting for the whole batch"), "a finished worker gets the next task at once");
        assert!(text.contains("write `docs/big-thing/BRIEF.md`") && text.contains("the milestone's check, run once"));
        assert!(text.contains("turned off for this run"));
        assert!(!text.contains(DELEGATE_NAME), "no subagents to name");
        let dispatched = build_briefing(&goal(), &plan(), &BriefingOptions { team: Some(&team), runner_dispatch: true, tools: true, ..Default::default() });
        assert!(dispatched.contains("Big Thing hands the milestone's ready tasks to these workers itself"));
        let alone = build_briefing(&goal(), &plan(), &BriefingOptions { agent: Some(Provider::Claude), ..Default::default() });
        assert!(alone.contains(&format!("subagent_type: {DELEGATE_NAME}")));
    }

    #[test]
    fn the_continuation_is_a_pointer_and_the_deltas() {
        let mut working = plan().remove(1);
        let mut done = step("s1", StepState::Done);
        done.title = "Layout".into();
        let mut next = step("s2", StepState::Pending);
        next.title = "Copy".into();
        working.steps = vec![done, next];
        let deltas = vec![
            Delta::Verified { milestone: 1, title: "Foundation".into(), evidence: "exit 0".into() },
            Delta::CheckFailed { milestone: 2, title: "Screens".into(), command: "pnpm test".into(), exit_code: 1, tail: "1 failed".into() },
            Delta::Budget { continuations_left: 1 },
        ];
        let notes = WorkspaceNotes { state: Some(NoteInfo { path: STATE_NOTE_PATH.into(), bytes: 3, modified_at_unix_ms: 0 }), agent_notes: vec![] };
        let text = build_continuation(&ContinuationInput {
            milestone: &working,
            index: 1,
            total: 2,
            deltas: &deltas,
            plan_path: Some("docs/plan.md"),
            notes: Some(Some(&notes)),
            agent_notes: &["docs/big-thing/agents/a.md".into()],
            now: 30 * 60_000,
            tools: false,
            runner_dispatch: false,
            full: true,
        });
        assert_eq!(text.split('\n').next().unwrap(), "Continue. Milestone 2/2: Screens.");
        assert!(text.contains("Spec: ## UI in `docs/plan.md`."));
        assert!(text.contains("2.1 [done] Layout\n2.2 [ready] Copy"));
        assert!(text.contains("(updated 30m ago)"));
        assert!(text.contains("- Milestone 1 verified (exit 0)."));
        assert!(text.contains("- Milestone 2 check failed: `pnpm test` exited 1. Tail: 1 failed"));
        assert!(text.contains("- 1 continuation left in the budget."));
        assert!(!text.contains("Its check"), "a manual milestone has no check line");
        assert!(!text.contains("Goal:"));
        assert!(!text.contains("tasks are ready"), "one ready task is not a parallel batch");
        let mut wide = working.clone();
        let mut third = step("s3", StepState::Pending);
        third.title = "Icons".into();
        wide.steps.push(third);
        let input = ContinuationInput { milestone: &wide, index: 1, total: 2, deltas: &[], plan_path: None, notes: None, agent_notes: &[], now: 0, tools: true, runner_dispatch: false, full: true };
        assert!(build_continuation(&input).contains("2 tasks are ready and wait on nothing"));
        assert!(!build_continuation(&ContinuationInput { runner_dispatch: true, ..input }).contains("tasks are ready"), "the runner hands them out itself");
        let mut checked = wide.clone();
        checked.check_kind = CheckKind::TestsPass;
        checked.check_spec = Some("pnpm test".into());
        checked.detail = "Build every screen".into();
        let again = build_continuation(&ContinuationInput { milestone: &checked, plan_path: Some("docs/plan.md"), full: false, ..input });
        assert!(again.starts_with("Continue. Milestone 2/2: Screens."));
        assert!(again.contains("2.2 [ready] Copy"), "the tasks still go out: their states move");
        assert!(!again.contains("Spec:") && !again.contains("Its check") && !again.contains("Build every screen"), "the spec went out already: {again}");
        let first = build_continuation(&ContinuationInput { milestone: &checked, plan_path: Some("docs/plan.md"), full: true, ..input });
        assert!(first.contains("Its check") && first.contains("Build every screen"));
    }

    #[test]
    fn the_planning_prompt_asks_for_the_tool_or_the_block() {
        let text = build_planning_prompt(&goal(), "# Roadmap", Some("roadmap.md"), true);
        assert!(text.contains("`bigthing_propose_plan`"));
        assert!(text.contains(PLAN_GRAMMAR));
        assert!(text.contains("**Plan for parallel work.**") && text.contains("only when a task truly cannot start"), "the planner is told to keep dependencies to what is real");
        assert!(text.contains("**Size every task in AI-agent time, not human time.**") && text.contains("10–30 minutes") && text.contains("Do not think in human hours"), "tasks are sized for agents, not people");
        assert!(!text.contains("three to eight"), "the count follows from the size, not a quota");
        assert!(text.ends_with("--- end of roadmap.md ---"));
    }
}
