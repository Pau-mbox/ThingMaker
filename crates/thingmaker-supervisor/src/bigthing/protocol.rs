//! The run protocol: what the agent sends back, read into typed messages.
//!
//! Two ways in, one shape out. The `bigthing_*` tools on the session's
//! `team` server deliver these directly; the text lines and blocks below are
//! the fallback for a provider that cannot load that server. Every parser is a
//! refusal machine: a missing or malformed line means "nothing was said",
//! never a guess. Nothing here can mark a milestone done — a report is a
//! claim, and the caller records it as one.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::storage::odyssey::{AmendmentRecord, AmendmentState, CheckKind, MilestoneRecord, MilestoneState, StepRecord, StepState};

// ---------------------------------------------------------------- grammars

pub const REPORT_GRAMMAR: &str = "BIGTHING-REPORT: milestone=<n> status=<complete|blocked> note=<one line>";
pub const TASK_GRAMMAR: &str = "BIGTHING-TASK: milestone=<m> task=<t> status=<in_progress|done|blocked> agent=<subagent name, optional> note=<one line, optional>";
pub const ASK_GRAMMAR: &str = "BIGTHING-ASK: kind=<ambiguity|architecture|conflict|failure|permission> default=<what you do until you hear back> options=<a | b | c, optional> question=<one line>";

pub const PLAN_GRAMMAR: &str = "BIGTHING-PLAN
milestone: <title>
detail: <one line, optional>
section: <the heading or line range of the document this milestone comes from, optional>
check: <manual | command <cmd> | tests_pass <cmd> | files_exist <paths>>
step: <task title, repeatable — three to eight per milestone, in order>
depends: <numbers of earlier tasks in this milestone the one above waits for, optional>
capability: <what the task needs from a worker, e.g. image or review, optional>
END-BIGTHING-PLAN";

pub const AMEND_GRAMMAR: &str = "BIGTHING-AMEND
add: <title>
after: <milestone number, or \"end\">
detail: <one line, optional>
section: <heading or line range in the plan document, optional>
check: <manual | command <cmd> | tests_pass <cmd> | files_exist <paths>>
step: <task title, optional, repeatable>
depends: <numbers of earlier tasks the one above waits for, optional>
revise: <milestone number>
title: <new title, optional>
detail: <new detail, optional>
section: <new section reference, optional>
check: <new check, optional>
step: <a task to add to it, optional, repeatable>
depends: <numbers of the milestone's tasks the one above waits for, optional>
drop: <milestone number>
reason: <one line>
drop_task: <task number, e.g. 7.4>
reason: <one line>
revise_task: <task number>
title: <new title, optional>
detail: <new detail, optional>
depends: <numbers of the milestone's tasks it waits for, optional>
split_task: <task number>
step: <each task that replaces it, repeatable>
depends: <numbers of the milestone's tasks the one above waits for, optional>
move_task: <task number>
after: <task number in the same milestone, or \"start\">
END-BIGTHING-AMEND";

/// The instruction appended once when any change amendment is carried.
pub const AMEND_INSTRUCTION: &str = "Fold the above into the plan when it fits — you decide where and when. Change the milestones with `bigthing_amend` (or a BIGTHING-AMEND block), and keep working in the same reply if you have work to do. If it needs no change to the plan, say so.";

/// Continuations to leave between tellings of the same amendment.
pub const RETELL_AFTER_CONTINUATIONS: i64 = 3;
/// Tellings before an amendment is handed back to the user.
pub const MAX_TELLS: i64 = 3;

pub const MAX_MILESTONES: usize = 40;
const MAX_STEPS: usize = 20;
const MAX_TITLE: usize = 120;
const MAX_DETAIL: usize = 3_000;
const MAX_SECTION: usize = 200;
const MAX_OPS: usize = 20;

pub const ALL_MANUAL_NOTE: &str = "Every milestone is manual, so the run will stop at each claim until you tick it. Set a test command in Settings and ask again, or edit the checks.";

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a valid pattern")
}

static REPORT_LINE: LazyLock<Regex> = LazyLock::new(|| re(r"(?im)^\s*(?:BIGTHING|SUPERTHING|ODYSSEY)-REPORT:[ \t]*(.+)$"));
static ASK_LINE: LazyLock<Regex> = LazyLock::new(|| re(r"(?im)^\s*(?:BIGTHING|SUPERTHING|ODYSSEY)-ASK:[ \t]*(.+)$"));
static TASK_LINE: LazyLock<Regex> = LazyLock::new(|| re(r"(?im)^\s*(?:BIGTHING|SUPERTHING|ODYSSEY)-TASK:[ \t]*(.+)$"));
static PLAN_BLOCK: LazyLock<Regex> = LazyLock::new(|| re(r"(?m)^[^\S\n]*(?:\*\*)?(?:BIGTHING|SUPERTHING|ODYSSEY)-PLAN(?:\*\*)?[^\S\n]*$([\s\S]*?)^[^\S\n]*(?:\*\*)?END-(?:BIGTHING|SUPERTHING|ODYSSEY)-PLAN(?:\*\*)?[^\S\n]*$"));
static AMEND_BLOCK: LazyLock<Regex> = LazyLock::new(|| re(r"(?m)^[^\S\n]*(?:\*\*)?(?:BIGTHING|SUPERTHING|ODYSSEY)-AMEND(?:\*\*)?[^\S\n]*$([\s\S]*?)^[^\S\n]*(?:\*\*)?END-(?:BIGTHING|SUPERTHING|ODYSSEY)-AMEND(?:\*\*)?[^\S\n]*$"));
static PLAN_KEY: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^(milestone|detail|section|check|step|task|depends|capability)\s*:\s*(.*)$"));
static AMEND_KEY: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^(add|revise|drop|drop_task|revise_task|split_task|move_task|after|title|detail|section|check|step|task|depends|capability|reason)\s*:\s*(.*)$"));

/// `key=value` inside a protocol line: the value runs to the next known key,
/// or to the end of the line for the last one.
fn field(body: &str, key: &str) -> Option<String> {
    let pattern = Regex::new(&format!(r"(?i)(?:^|\s){key}\s*=\s*")).ok()?;
    let found = pattern.find(body)?;
    Some(body[found.end()..].to_string())
}

fn number_field(body: &str, key: &str) -> Option<usize> {
    let value = field(body, key)?;
    let digits: String = value.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

fn word_field(body: &str, key: &str) -> Option<String> {
    let value = field(body, key)?;
    let word: String = value.chars().take_while(|c| !c.is_whitespace()).collect();
    (!word.is_empty()).then_some(word)
}

/// A value that runs until the next ` <other>=` key, or the end.
fn bounded_field(body: &str, key: &str, others: &[&str]) -> Option<String> {
    let value = field(body, key)?;
    let stop = Regex::new(&format!(r"(?i)\s+(?:{})\s*=", others.join("|"))).ok()?;
    let end = stop.find(&value).map(|found| found.start()).unwrap_or(value.len());
    Some(value[..end].trim().to_string())
}

fn clamp(text: &str, limit: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate(&collapsed, limit)
}

fn clamp_lines(text: &str, limit: usize) -> String {
    let trimmed = text.split('\n').map(str::trim_end).collect::<Vec<_>>().join("\n").trim().to_string();
    truncate(&trimmed, limit)
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let cut: String = text.chars().take(limit.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

/// Strips the decoration a model adds around a keyed line.
fn bare(line: &str) -> String {
    static LEAD: LazyLock<Regex> = LazyLock::new(|| re(r"^(?:[-*+]\s+|\d+[.)]\s+)"));
    let line = line.trim();
    let line = LEAD.replace(line, "");
    line.replace("**", "").trim().to_string()
}

// ------------------------------------------------------------------ report

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportStatus {
    Complete,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Report {
    /// 1-based, as the model was shown it.
    pub milestone: usize,
    pub status: ReportStatus,
    #[serde(default)]
    pub note: String,
}

/// The last report line in a reply.
pub fn parse_report(text: &str) -> Option<Report> {
    let body = REPORT_LINE.captures_iter(text).last()?.get(1)?.as_str().to_string();
    let milestone = number_field(&body, "milestone")?;
    let status = word_field(&body, "status")?.to_lowercase();
    let status = if status.starts_with("complete") {
        ReportStatus::Complete
    } else if status.starts_with("blocked") {
        ReportStatus::Blocked
    } else {
        return None;
    };
    if milestone < 1 {
        return None;
    }
    let note = field(&body, "note").map(|note| note.trim().to_string()).unwrap_or_default();
    Some(Report { milestone, status, note })
}

// --------------------------------------------------------------------- ask

pub const ASK_KINDS: [&str; 5] = ["ambiguity", "architecture", "conflict", "failure", "permission"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ask {
    pub kind: String,
    #[serde(default)]
    pub fallback: String,
    #[serde(default)]
    pub options: Vec<String>,
    pub question: String,
}

pub fn ask_kind(kind: Option<&str>) -> String {
    let kind = kind.unwrap_or("").to_lowercase();
    if ASK_KINDS.contains(&kind.as_str()) { kind } else { "ambiguity".into() }
}

/// Every readable ask in a reply, in order.
pub fn parse_asks(text: &str) -> Vec<Ask> {
    let mut asks = Vec::new();
    static QUESTION: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(?:^|\s)question\s*=\s*"));
    for captures in ASK_LINE.captures_iter(text) {
        let body = captures.get(1).map(|m| m.as_str()).unwrap_or("");
        let Some(found) = QUESTION.find(body) else { continue };
        let question = body[found.end()..].trim().to_string();
        if question.is_empty() {
            continue;
        }
        let head = &body[..found.start()];
        let kind = ask_kind(word_field(head, "kind").as_deref());
        let fallback = bounded_field(head, "default", &["options", "kind"]).unwrap_or_default();
        let options = bounded_field(head, "options", &["default", "kind"])
            .map(|text| text.split('|').map(str::trim).filter(|option| !option.is_empty()).map(str::to_string).collect())
            .unwrap_or_default();
        asks.push(Ask { kind, fallback, options, question });
    }
    asks
}

// -------------------------------------------------------------------- task

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    InProgress,
    Done,
    Blocked,
}

impl TaskStatus {
    pub fn step_state(self) -> StepState {
        match self {
            Self::InProgress => StepState::InProgress,
            Self::Done => StepState::Done,
            Self::Blocked => StepState::Blocked,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskLine {
    pub milestone: usize,
    pub task: usize,
    pub status: TaskStatus,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub note: String,
}

/// Every readable task line in a reply, in order.
pub fn parse_task_lines(text: &str) -> Vec<TaskLine> {
    let mut lines = Vec::new();
    for captures in TASK_LINE.captures_iter(text) {
        let body = captures.get(1).map(|m| m.as_str()).unwrap_or("");
        let (Some(milestone), Some(task), Some(status)) = (number_field(body, "milestone"), number_field(body, "task"), word_field(body, "status")) else { continue };
        let status = match status.to_lowercase().as_str() {
            "in_progress" => TaskStatus::InProgress,
            "done" => TaskStatus::Done,
            "blocked" => TaskStatus::Blocked,
            _ => continue,
        };
        if milestone < 1 || task < 1 {
            continue;
        }
        let agent = word_field(body, "agent").map(|agent| agent.trim_matches('`').to_string()).filter(|agent| agent != "-" && !agent.is_empty());
        let note = field(body, "note").map(|note| note.trim().to_string()).unwrap_or_default();
        lines.push(TaskLine { milestone, task, status, agent, note });
    }
    lines
}

/// A task's state for the screen and the prompt: `waiting` is derived.
pub fn task_status(step: &StepRecord, siblings: &[StepRecord]) -> &'static str {
    match step.state {
        StepState::InProgress => "in_progress",
        StepState::Done => "done",
        StepState::Blocked => "blocked",
        StepState::Pending => {
            let waiting = step.depends_on.iter().any(|id| siblings.iter().find(|sibling| &sibling.id == id).is_some_and(|dependency| dependency.state != StepState::Done));
            if waiting { "waiting" } else { "pending" }
        }
    }
}

pub fn task_number(milestone_index: usize, task_index: usize) -> String {
    format!("{}.{}", milestone_index + 1, task_index + 1)
}

/// Tasks that can start now: not started, nothing they wait for open.
pub fn ready_tasks(steps: &[StepRecord]) -> Vec<usize> {
    (0..steps.len()).filter(|index| task_status(&steps[*index], steps) == "pending").collect()
}

/// The milestone's tasks one line each, with the state the record holds.
pub fn task_lines_for(milestone_index: usize, steps: &[StepRecord]) -> Vec<String> {
    steps
        .iter()
        .enumerate()
        .map(|(index, step)| {
            let status = task_status(step, steps);
            let label = match status {
                "waiting" => {
                    let mut numbers: Vec<usize> = step.depends_on.iter().filter_map(|id| steps.iter().position(|sibling| &sibling.id == id)).collect();
                    numbers.sort_unstable();
                    format!("waiting on {}", numbers.iter().map(|n| task_number(milestone_index, *n)).collect::<Vec<_>>().join(", "))
                }
                "pending" => "ready".into(),
                other => other.replace('_', " "),
            };
            let owner = step.agent_name.as_deref().map(|name| format!(" — {name}")).unwrap_or_default();
            format!("{} [{label}] {}{owner}", task_number(milestone_index, index), step.title)
        })
        .collect()
}

/// The task a subagent or job is on, from its name: the name the agent gave
/// on a task line, or a name starting with the task's number (`6.3-pricing`).
pub fn match_agent_to_task(name: &str, milestones: &[MilestoneRecord]) -> Option<(usize, usize)> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    for (milestone_index, milestone) in milestones.iter().enumerate() {
        if let Some(step_index) = milestone.steps.iter().position(|step| step.agent_name.as_deref() == Some(name)) {
            return Some((milestone_index, step_index));
        }
    }
    static NUMBERED: LazyLock<Regex> = LazyLock::new(|| re(r"^(\d+)\.(\d+)(?:\b|[-_ ])"));
    let captures = NUMBERED.captures(name)?;
    let milestone_index = captures[1].parse::<usize>().ok()?.checked_sub(1)?;
    let step_index = captures[2].parse::<usize>().ok()?.checked_sub(1)?;
    milestones.get(milestone_index)?.steps.get(step_index)?;
    Some((milestone_index, step_index))
}

// -------------------------------------------------------------------- plan

/// A task as a plan or an amendment proposes it. `depends` are 1-based
/// numbers within the same milestone.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedTask {
    pub title: String,
    #[serde(default)]
    pub depends: Vec<usize>,
    /// What the task needs from a worker (`image`, `review`), for the
    /// runner's dispatch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedMilestone {
    pub title: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub section: Option<String>,
    #[serde(default)]
    pub check_kind: CheckKind,
    #[serde(default)]
    pub check_spec: Option<String>,
    #[serde(default)]
    pub steps: Vec<ProposedTask>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProposedPlan {
    pub milestones: Vec<ProposedMilestone>,
    /// What was adjusted or ignored while reading it.
    pub notes: Vec<String>,
}

/// `depends: 1, 3` (or `6.1, 6.3`) as task numbers.
pub fn read_depends(value: &str) -> Vec<usize> {
    let mut out = Vec::new();
    for part in value.split(|c: char| c == ',' || c == ';' || c.is_whitespace()) {
        let part = part.trim();
        let part = part.rsplit_once('.').map(|(_, task)| task).unwrap_or(part);
        if let Ok(number) = part.parse::<usize>()
            && number >= 1
            && !out.contains(&number)
        {
            out.push(number);
        }
    }
    out
}

pub const CHECK_KINDS: [CheckKind; 4] = [CheckKind::Manual, CheckKind::Command, CheckKind::TestsPass, CheckKind::FilesExist];

/// Reads a check: the kind has to be named, never guessed from a bare string.
pub fn read_check(value: &str) -> (CheckKind, Option<String>, Option<String>) {
    let text = value.trim().trim_start_matches('`').trim_end_matches('`').trim();
    let lower = text.to_lowercase();
    let Some(kind) = CHECK_KINDS.iter().copied().find(|kind| text == kind.as_str() || lower.starts_with(&format!("{} ", kind.as_str()))) else {
        return (
            CheckKind::Manual,
            None,
            Some(format!("A check of \"{}\" does not name one of manual, command, tests_pass, files_exist, so that milestone is yours to tick.", clamp(text, 60))),
        );
    };
    if kind == CheckKind::Manual {
        return (CheckKind::Manual, None, None);
    }
    let spec = text[kind.as_str().len()..].trim();
    let spec = spec.strip_prefix('`').and_then(|inner| inner.strip_suffix('`')).unwrap_or(spec).trim();
    if spec.is_empty() {
        return (CheckKind::Manual, None, Some(format!("A {} check was proposed with nothing to run, so that milestone is yours to tick.", kind.as_str())));
    }
    if spec.contains('\n') {
        return (CheckKind::Manual, None, Some("A check spanning several lines was ignored.".into()));
    }
    (kind, Some(spec.to_string()), None)
}

/// The last plan block in a reply, or `None` when there is no readable plan.
pub fn parse_plan(text: &str) -> Option<ProposedPlan> {
    let body = PLAN_BLOCK.captures_iter(text).last()?.get(1)?.as_str().to_string();
    let mut milestones: Vec<ProposedMilestone> = Vec::new();
    let mut notes = Vec::new();
    let mut dropped = 0;
    for raw in body.split('\n') {
        let line = bare(raw);
        let Some(captures) = PLAN_KEY.captures(&line) else { continue };
        let key = captures[1].to_lowercase();
        let value = captures[2].trim().to_string();
        if key == "milestone" {
            if value.is_empty() {
                continue;
            }
            if milestones.len() >= MAX_MILESTONES {
                dropped += 1;
                continue;
            }
            milestones.push(ProposedMilestone { title: clamp(&value, MAX_TITLE), detail: String::new(), section: None, check_kind: CheckKind::Manual, check_spec: None, steps: Vec::new() });
            continue;
        }
        let Some(current) = milestones.last_mut() else { continue };
        match key.as_str() {
            "detail" => current.detail = clamp_lines(&if current.detail.is_empty() { value } else { format!("{}\n{value}", current.detail) }, MAX_DETAIL),
            "section" => {
                if !value.is_empty() {
                    current.section = Some(clamp(&value.replace('`', ""), MAX_SECTION));
                }
            }
            "step" | "task" => {
                if !value.is_empty() && current.steps.len() < MAX_STEPS {
                    current.steps.push(ProposedTask { title: clamp(&value, MAX_TITLE), depends: Vec::new(), capability: None });
                }
            }
            "depends" => {
                let count = current.steps.len();
                if let Some(task) = current.steps.last_mut() {
                    task.depends = read_depends(&value).into_iter().filter(|n| *n < count).collect();
                }
            }
            "capability" => {
                if let Some(task) = current.steps.last_mut() {
                    task.capability = Some(value.to_lowercase()).filter(|value| !value.is_empty());
                }
            }
            "check" => {
                let (kind, spec, note) = read_check(&value);
                current.check_kind = kind;
                current.check_spec = spec;
                notes.extend(note);
            }
            _ => {}
        }
    }
    finish_plan(milestones, notes, dropped)
}

/// Bounds and notes shared by the text block and the tool.
pub fn finish_plan(milestones: Vec<ProposedMilestone>, mut notes: Vec<String>, dropped: usize) -> Option<ProposedPlan> {
    if milestones.is_empty() {
        return None;
    }
    if dropped > 0 {
        notes.push(format!("The plan proposed more than {MAX_MILESTONES} milestones; {dropped} beyond the limit were dropped."));
    }
    let runnable = milestones.iter().filter(|milestone| milestone.check_spec.is_some()).count();
    if runnable > 0 {
        notes.push(format!("{runnable} milestone{} Big Thing can run. Read the commands before you start the run.", if runnable == 1 { " has a check" } else { "s have checks" }));
    } else {
        notes.push(ALL_MANUAL_NOTE.into());
    }
    Some(ProposedPlan { milestones, notes })
}

/// A plan sent through the tool, bounded the same way as the block.
pub fn tidy_plan(mut milestones: Vec<ProposedMilestone>) -> Option<ProposedPlan> {
    let mut notes = Vec::new();
    let dropped = milestones.len().saturating_sub(MAX_MILESTONES);
    milestones.truncate(MAX_MILESTONES);
    let milestones: Vec<ProposedMilestone> = milestones
        .into_iter()
        .filter(|milestone| !milestone.title.trim().is_empty())
        .map(|mut milestone| {
            milestone.title = clamp(&milestone.title, MAX_TITLE);
            milestone.detail = clamp_lines(&milestone.detail, MAX_DETAIL);
            milestone.section = milestone.section.map(|section| clamp(&section.replace('`', ""), MAX_SECTION)).filter(|section| !section.is_empty());
            if milestone.check_kind == CheckKind::Manual {
                milestone.check_spec = None;
            } else if milestone.check_spec.as_deref().is_none_or(|spec| spec.trim().is_empty() || spec.contains('\n')) {
                notes.push(format!("A {} check was proposed with nothing usable to run, so that milestone is yours to tick.", milestone.check_kind.as_str()));
                milestone.check_kind = CheckKind::Manual;
                milestone.check_spec = None;
            }
            milestone.steps.truncate(MAX_STEPS);
            let count = milestone.steps.len();
            for (index, step) in milestone.steps.iter_mut().enumerate() {
                step.title = clamp(&step.title, MAX_TITLE);
                step.depends.retain(|n| *n >= 1 && *n <= index && *n < count);
            }
            milestone.steps.retain(|step| !step.title.is_empty());
            milestone
        })
        .collect();
    finish_plan(milestones, notes, dropped)
}

// ------------------------------------------------------------------- amend

/// Where an added milestone goes, or where a moved task goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Place {
    After(usize),
    Named(PlaceName),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaceName {
    End,
    Start,
}

/// `7.4`: milestone 7, its fourth task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskRef {
    pub milestone: usize,
    pub task: usize,
}

impl TaskRef {
    pub fn parse(value: &str) -> Option<Self> {
        let (milestone, task) = value.trim().split_once('.')?;
        let milestone: usize = milestone.parse().ok()?;
        let task: usize = task.parse().ok()?;
        (milestone >= 1 && task >= 1).then_some(Self { milestone, task })
    }

    pub fn label(&self) -> String {
        format!("{}.{}", self.milestone, self.task)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum AmendOp {
    Add {
        title: String,
        #[serde(default)]
        detail: String,
        #[serde(default)]
        section: Option<String>,
        #[serde(default)]
        check_kind: CheckKind,
        #[serde(default)]
        check_spec: Option<String>,
        #[serde(default)]
        steps: Vec<ProposedTask>,
        #[serde(default = "end")]
        after: Place,
    },
    Revise {
        target: usize,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        detail: Option<String>,
        #[serde(default)]
        section: Option<String>,
        #[serde(default)]
        check_kind: Option<CheckKind>,
        #[serde(default)]
        check_spec: Option<String>,
        #[serde(default)]
        steps: Vec<ProposedTask>,
    },
    Drop {
        target: usize,
        #[serde(default)]
        reason: String,
    },
    DropTask {
        #[serde(rename = "ref")]
        task: TaskRef,
        #[serde(default)]
        reason: String,
    },
    ReviseTask {
        #[serde(rename = "ref")]
        task: TaskRef,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        detail: Option<String>,
        #[serde(default)]
        depends: Option<Vec<usize>>,
        #[serde(default)]
        reason: String,
    },
    SplitTask {
        #[serde(rename = "ref")]
        task: TaskRef,
        #[serde(default)]
        steps: Vec<ProposedTask>,
        #[serde(default)]
        reason: String,
    },
    MoveTask {
        #[serde(rename = "ref")]
        task: TaskRef,
        #[serde(default = "start")]
        after: Place,
        #[serde(default)]
        reason: String,
    },
}

fn end() -> Place {
    Place::Named(PlaceName::End)
}

fn start() -> Place {
    Place::Named(PlaceName::Start)
}

impl AmendOp {
    pub fn reason(&self) -> &str {
        match self {
            Self::Drop { reason, .. } | Self::DropTask { reason, .. } | Self::ReviseTask { reason, .. } | Self::SplitTask { reason, .. } | Self::MoveTask { reason, .. } => reason,
            _ => "",
        }
    }

    /// Whether it changes what a milestone is (its existence, title or
    /// check) rather than how its work is cut into tasks.
    pub fn is_milestone_scope(&self) -> bool {
        match self {
            Self::Add { .. } | Self::Drop { .. } => true,
            Self::Revise { title, check_kind, .. } => title.is_some() || check_kind.is_some(),
            _ => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Amendment {
    pub ops: Vec<AmendOp>,
    pub notes: Vec<String>,
}

fn position(value: &str) -> Option<usize> {
    let digits: String = value.trim().chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok().filter(|n| *n >= 1)
}

/// The last amendment block in a reply.
pub fn parse_amendment(text: &str) -> Option<Amendment> {
    let body = AMEND_BLOCK.captures_iter(text).last()?.get(1)?.as_str().to_string();
    let mut ops: Vec<AmendOp> = Vec::new();
    let mut notes = Vec::new();
    let mut dropped = 0;
    for raw in body.split('\n') {
        let line = bare(raw);
        let Some(captures) = AMEND_KEY.captures(&line) else { continue };
        let key = captures[1].to_lowercase();
        let value = captures[2].trim().to_string();

        if matches!(key.as_str(), "drop_task" | "revise_task" | "split_task" | "move_task") {
            if ops.len() >= MAX_OPS {
                dropped += 1;
                continue;
            }
            let Some(task) = TaskRef::parse(&value) else {
                notes.push(format!("A {} named \"{}\" rather than a task number like 7.4, so it was ignored.", key.replacen('_', " ", 1), clamp(&value, 40)));
                continue;
            };
            ops.push(match key.as_str() {
                "drop_task" => AmendOp::DropTask { task, reason: String::new() },
                "revise_task" => AmendOp::ReviseTask { task, title: None, detail: None, depends: None, reason: String::new() },
                "split_task" => AmendOp::SplitTask { task, steps: Vec::new(), reason: String::new() },
                _ => AmendOp::MoveTask { task, after: start(), reason: String::new() },
            });
            continue;
        }
        if matches!(key.as_str(), "add" | "revise" | "drop") {
            if ops.len() >= MAX_OPS {
                dropped += 1;
                continue;
            }
            if key == "add" {
                if value.is_empty() {
                    continue;
                }
                ops.push(AmendOp::Add { title: clamp(&value, MAX_TITLE), detail: String::new(), section: None, check_kind: CheckKind::Manual, check_spec: None, steps: Vec::new(), after: end() });
            } else {
                let Some(target) = position(&value) else {
                    notes.push(format!("A {key} named \"{}\" rather than a milestone number, so it was ignored.", clamp(&value, 40)));
                    continue;
                };
                ops.push(if key == "revise" {
                    AmendOp::Revise { target, title: None, detail: None, section: None, check_kind: None, check_spec: None, steps: Vec::new() }
                } else {
                    AmendOp::Drop { target, reason: String::new() }
                });
            }
            continue;
        }
        let Some(current) = ops.last_mut() else { continue };
        apply_amend_key(current, &key, &value, &mut notes);
    }
    if ops.is_empty() {
        return None;
    }
    if dropped > 0 {
        notes.push(format!("The block asked for more than {MAX_OPS} changes; {dropped} beyond the limit were ignored."));
    }
    Some(Amendment { ops, notes })
}

fn join_detail(existing: &str, value: &str) -> String {
    clamp_lines(&if existing.is_empty() { value.to_string() } else { format!("{existing}\n{value}") }, MAX_DETAIL)
}

fn apply_amend_key(current: &mut AmendOp, key: &str, value: &str, notes: &mut Vec<String>) {
    match (key, current) {
        ("after", AmendOp::Add { after, .. }) => {
            *after = if value.eq_ignore_ascii_case("end") { end() } else { position(value).map(Place::After).unwrap_or_else(end) };
        }
        ("after", AmendOp::MoveTask { after, .. }) => {
            *after = if value.eq_ignore_ascii_case("start") {
                start()
            } else {
                TaskRef::parse(value).map(|reference| reference.task).or_else(|| position(value)).map(Place::After).unwrap_or_else(start)
            };
        }
        ("title", AmendOp::Revise { title, .. } | AmendOp::ReviseTask { title, .. }) => {
            if !value.is_empty() {
                *title = Some(clamp(value, MAX_TITLE));
            }
        }
        ("detail", AmendOp::Add { detail, .. }) => *detail = join_detail(detail, value),
        ("detail", AmendOp::Revise { detail, .. } | AmendOp::ReviseTask { detail, .. }) => *detail = Some(join_detail(detail.as_deref().unwrap_or(""), value)),
        ("section", AmendOp::Add { section, .. } | AmendOp::Revise { section, .. }) => {
            if !value.is_empty() {
                *section = Some(clamp(&value.replace('`', ""), MAX_SECTION));
            }
        }
        ("step" | "task", AmendOp::Add { steps, .. } | AmendOp::Revise { steps, .. } | AmendOp::SplitTask { steps, .. }) => {
            if !value.is_empty() && steps.len() < MAX_STEPS {
                steps.push(ProposedTask { title: clamp(value, MAX_TITLE), depends: Vec::new(), capability: None });
            }
        }
        ("depends", AmendOp::ReviseTask { depends, .. }) => *depends = Some(read_depends(value)),
        ("depends", AmendOp::Add { steps, .. } | AmendOp::Revise { steps, .. } | AmendOp::SplitTask { steps, .. }) => {
            if let Some(task) = steps.last_mut() {
                task.depends = read_depends(value);
            }
        }
        ("capability", AmendOp::Add { steps, .. } | AmendOp::Revise { steps, .. } | AmendOp::SplitTask { steps, .. }) => {
            if let Some(task) = steps.last_mut() {
                task.capability = Some(value.to_lowercase()).filter(|value| !value.is_empty());
            }
        }
        ("check", AmendOp::Add { check_kind, check_spec, .. }) => {
            let (kind, spec, note) = read_check(value);
            *check_kind = kind;
            *check_spec = spec;
            notes.extend(note.map(|note| note.replace("so that milestone is yours to tick", "so it was left for you to tick")));
        }
        ("check", AmendOp::Revise { check_kind, check_spec, .. }) => {
            let (kind, spec, note) = read_check(value);
            *check_kind = Some(kind);
            *check_spec = spec;
            notes.extend(note.map(|note| note.replace("so that milestone is yours to tick", "so it was left for you to tick")));
        }
        ("reason", AmendOp::Drop { reason, .. } | AmendOp::DropTask { reason, .. } | AmendOp::ReviseTask { reason, .. } | AmendOp::SplitTask { reason, .. } | AmendOp::MoveTask { reason, .. }) => {
            *reason = clamp(value, MAX_DETAIL);
        }
        _ => {}
    }
}

/// An operation tied to what it names, or refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedOp {
    pub op: AmendOp,
    pub milestone: Option<usize>,
    pub step: Option<usize>,
    pub refused: Option<String>,
}

/// Ties each operation to the milestone it names, against the list as it was
/// before anything is applied, and refuses what cannot be honoured: verified
/// milestones and done tasks are settled work.
pub fn resolve_ops(ops: &[AmendOp], milestones: &[MilestoneRecord]) -> Vec<ResolvedOp> {
    ops.iter()
        .map(|op| {
            let resolved = |milestone, step, refused: Option<String>| ResolvedOp { op: op.clone(), milestone, step, refused };
            match op {
                AmendOp::Add { .. } => resolved(None, None, None),
                AmendOp::Revise { target, .. } | AmendOp::Drop { target, .. } => {
                    let index = target - 1;
                    let Some(milestone) = milestones.get(index) else { return resolved(None, None, Some(format!("there is no milestone {target}"))) };
                    if milestone.state == MilestoneState::Verified {
                        return resolved(Some(index), None, Some(format!("milestone {target} is already verified, and verified work is not rewritten")));
                    }
                    resolved(Some(index), None, None)
                }
                AmendOp::DropTask { task, .. } | AmendOp::ReviseTask { task, .. } | AmendOp::SplitTask { task, .. } | AmendOp::MoveTask { task, .. } => {
                    let index = task.milestone - 1;
                    let Some(milestone) = milestones.get(index) else { return resolved(None, None, Some(format!("there is no milestone {}", task.milestone))) };
                    if milestone.state == MilestoneState::Verified {
                        return resolved(Some(index), None, Some(format!("milestone {} is already verified, and verified work is not rewritten", task.milestone)));
                    }
                    let step_index = task.task - 1;
                    let Some(step) = milestone.steps.get(step_index) else { return resolved(Some(index), None, Some(format!("milestone {} has no task {}", task.milestone, task.task))) };
                    if matches!(op, AmendOp::DropTask { .. } | AmendOp::SplitTask { .. }) && step.state == StepState::Done {
                        return resolved(Some(index), Some(step_index), Some(format!("task {} is done, and done work is not rewritten", task.label())));
                    }
                    if let AmendOp::SplitTask { steps, .. } = op
                        && steps.len() < 2
                    {
                        return resolved(Some(index), Some(step_index), Some(format!("a split needs at least two tasks to replace {}", task.label())));
                    }
                    resolved(Some(index), Some(step_index), None)
                }
            }
        })
        .collect()
}

/// One line of the plan diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiffLine {
    pub sign: &'static str,
    pub text: String,
    pub refused: Option<String>,
    pub reason: Option<String>,
}

fn plural(count: usize, noun: &str) -> String {
    format!("{count} {noun}{}", if count == 1 { "" } else { "s" })
}

/// The diff the user reads before a plan change lands.
pub fn plan_diff(resolved: &[ResolvedOp], milestones: &[MilestoneRecord]) -> Vec<DiffLine> {
    resolved
        .iter()
        .map(|entry| {
            let milestone = entry.milestone.and_then(|index| milestones.get(index));
            let step = milestone.and_then(|milestone| entry.step.and_then(|index| milestone.steps.get(index)));
            let r#where = milestone.map(|milestone| format!(" \"{}\"", milestone.title)).unwrap_or_default();
            let task_title = step.map(|step| format!(" \"{}\"", step.title)).unwrap_or_default();
            let line = |sign: &'static str, text: String, reason: &str| DiffLine {
                sign,
                text,
                refused: entry.refused.clone(),
                reason: Some(reason.trim().to_string()).filter(|reason| !reason.is_empty()),
            };
            match &entry.op {
                AmendOp::Add { title, steps, after, .. } => {
                    let place = match after {
                        Place::After(n) => format!("after milestone {n}"),
                        _ => "at the end".into(),
                    };
                    let tasks = if steps.is_empty() { String::new() } else { format!(" with {}", plural(steps.len(), "task")) };
                    line("+", format!("Add milestone \"{title}\" {place}{tasks}"), "")
                }
                AmendOp::Revise { target, title, detail, section, check_kind, check_spec, steps } => {
                    let mut parts = Vec::new();
                    if let Some(title) = title {
                        parts.push(format!("title → \"{title}\""));
                    }
                    if detail.is_some() {
                        parts.push("detail".into());
                    }
                    if let Some(section) = section {
                        parts.push(format!("spec → {section}"));
                    }
                    if let Some(kind) = check_kind {
                        parts.push(format!("check → {}{}", kind.as_str(), check_spec.as_deref().map(|spec| format!(" {spec}")).unwrap_or_default()));
                    }
                    if !steps.is_empty() {
                        parts.push(format!("+{}: {}", plural(steps.len(), "task"), steps.iter().map(|step| step.title.as_str()).collect::<Vec<_>>().join(", ")));
                    }
                    line("~", format!("Revise milestone {target}{where}{}", if parts.is_empty() { String::new() } else { format!(": {}", parts.join(", ")) }), "")
                }
                AmendOp::Drop { target, reason } => line("−", format!("Drop milestone {target}{where}"), reason),
                AmendOp::DropTask { task, reason } => line("−", format!("Drop task {}{task_title}", task.label()), reason),
                AmendOp::ReviseTask { task, title, detail, depends, reason } => {
                    let mut parts = Vec::new();
                    if let Some(title) = title {
                        parts.push(format!("title → \"{title}\""));
                    }
                    if detail.is_some() {
                        parts.push("detail".into());
                    }
                    if let Some(depends) = depends {
                        parts.push(format!(
                            "depends on {}",
                            if depends.is_empty() { "nothing".to_string() } else { depends.iter().map(|n| format!("{}.{n}", task.milestone)).collect::<Vec<_>>().join(", ") }
                        ));
                    }
                    line("~", format!("Revise task {}{task_title}{}", task.label(), if parts.is_empty() { String::new() } else { format!(": {}", parts.join(", ")) }), reason)
                }
                AmendOp::SplitTask { task, steps, reason } => line(
                    "⇄",
                    format!("Split task {}{task_title} into {}: {}", task.label(), steps.len(), steps.iter().map(|step| step.title.as_str()).collect::<Vec<_>>().join(", ")),
                    reason,
                ),
                AmendOp::MoveTask { task, after, reason } => {
                    let place = match after {
                        Place::After(n) => format!("after {}.{n}", task.milestone),
                        _ => "to the start".into(),
                    };
                    line("↕", format!("Move task {}{task_title} {place}", task.label()), reason)
                }
            }
        })
        .collect()
}

fn diff_line_text(entry: &DiffLine) -> String {
    format!(
        "{}{}{}",
        entry.text,
        entry.reason.as_deref().map(|reason| format!(" ({reason})")).unwrap_or_default(),
        entry.refused.as_deref().map(|refused| format!(" — refused: {refused}")).unwrap_or_default()
    )
}

/// The diff as text, for the record and the prompt.
pub fn diff_text(lines: &[DiffLine]) -> String {
    lines.iter().map(|entry| format!("{} {}", entry.sign, diff_line_text(entry))).collect::<Vec<_>>().join("\n")
}

/// One operation as a line, for the journal.
pub fn describe_op(resolved: &ResolvedOp, milestones: &[MilestoneRecord]) -> String {
    plan_diff(std::slice::from_ref(resolved), milestones).first().map(diff_line_text).unwrap_or_default()
}

/// Whether this amendment belongs on the next prompt: pending ones always,
/// told ones again after a few turns, up to a bound.
pub fn should_carry(record: &AmendmentRecord, continuations_used: i64) -> bool {
    match record.state {
        AmendmentState::Pending => true,
        AmendmentState::Told => {
            if record.tell_count >= MAX_TELLS {
                return false;
            }
            match record.told_at_continuation {
                None => true,
                Some(told) => continuations_used - told >= RETELL_AFTER_CONTINUATIONS,
            }
        }
        _ => false,
    }
}

/// How an amendment reads in the prompt that carries it.
pub fn describe_amendment(record: &AmendmentRecord, document: Option<&str>) -> Vec<String> {
    let mut lines = vec![if record.kind == "note" { format!("- A note from the user: {}", record.note) } else { format!("- The user added something to fold into the plan: {}", record.note) }];
    for reference in &record.refs {
        lines.push(format!("  Reference: `{}` ({}, {}) — open it yourself.", reference.path, reference.kind, reference.detail));
    }
    if let (Some(source), Some(document)) = (record.document_source.as_deref(), document) {
        lines.push(format!("  Document `{source}` (it is not in the workspace, so it is quoted here):"));
        lines.push(format!("  --- {source} ---"));
        lines.push(document.to_string());
        lines.push(format!("  --- end of {source} ---"));
    }
    lines
}

pub fn retell_note(record: &AmendmentRecord) -> String {
    if record.tell_count == 1 {
        "  You were asked this once already and have not folded it in. Do it now, or say in your reply why it does not belong in the plan.".into()
    } else {
        format!("  You were asked this {} times already. Fold it in now, or say plainly that you will not and why.", record.tell_count)
    }
}

/// What one turn sent, by either route.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnProtocol {
    pub report: Option<Report>,
    pub asks: Vec<Ask>,
    pub tasks: Vec<TaskLine>,
    pub amendment: Option<Amendment>,
    pub plan: Option<ProposedPlan>,
}

impl TurnProtocol {
    /// Reads the text fallback, then lets what came through the tools win:
    /// a tool call is the agent's deliberate word, a line in prose may be a
    /// quote.
    pub fn read(text: &str, tools: TurnProtocol) -> Self {
        let mut amendment = parse_amendment(text);
        if let Some(from_tools) = tools.amendment {
            amendment = Some(from_tools);
        }
        let mut asks = tools.asks;
        for ask in parse_asks(text) {
            if !asks.iter().any(|existing| existing.question == ask.question) {
                asks.push(ask);
            }
        }
        let mut tasks = parse_task_lines(text);
        tasks.extend(tools.tasks);
        Self { report: tools.report.or_else(|| parse_report(text)), asks, tasks, amendment, plan: tools.plan.or_else(|| parse_plan(text)) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bigthing::tests::{milestone, step};

    #[test]
    fn lines_written_under_the_earlier_names_still_read() {
        assert_eq!(parse_report("SUPERTHING-REPORT: milestone=2 status=complete note=x").unwrap().milestone, 2);
        assert_eq!(parse_report("ODYSSEY-REPORT: milestone=3 status=blocked note=y").unwrap().milestone, 3);
        assert_eq!(parse_task_lines("SUPERTHING-TASK: milestone=1 task=2 status=done").len(), 1);
        assert!(parse_plan("SUPERTHING-PLAN\nmilestone: One\nEND-SUPERTHING-PLAN").is_some());
    }

    #[test]
    fn a_report_is_read_or_refused() {
        assert_eq!(parse_report("Done.\nODYSSEY-REPORT: milestone=3 status=complete note=screens built"), Some(Report { milestone: 3, status: ReportStatus::Complete, note: "screens built".into() }));
        let restated = "BIGTHING-REPORT: milestone=1 status=blocked note=first\ntext\nODYSSEY-REPORT: milestone=2 status=complete note=second";
        assert_eq!(parse_report(restated).unwrap().milestone, 2);
        assert_eq!(parse_report("odyssey-report:  milestone = 2   status = BLOCKED"), Some(Report { milestone: 2, status: ReportStatus::Blocked, note: String::new() }));
        for bad in ["I finished the milestone!", "BIGTHING-REPORT: status=complete", "BIGTHING-REPORT: milestone=0 status=complete", "BIGTHING-REPORT: milestone=2 status=nearly", ""] {
            assert_eq!(parse_report(bad), None, "{bad}");
        }
    }

    #[test]
    fn asks_and_task_lines_are_read_one_per_line() {
        let asks = parse_asks("BIGTHING-ASK: kind=architecture default=keep SQLite options=SQLite | Postgres question=Which database should the service use?\nBIGTHING-ASK: kind=bogus question=Second?\nBIGTHING-ASK: kind=failure default=x");
        assert_eq!(asks.len(), 2);
        assert_eq!(asks[0], Ask { kind: "architecture".into(), fallback: "keep SQLite".into(), options: vec!["SQLite".into(), "Postgres".into()], question: "Which database should the service use?".into() });
        assert_eq!(asks[1].kind, "ambiguity");
        let tasks = parse_task_lines("BIGTHING-TASK: milestone=6 task=3 status=done agent=`6.3-pricing` note=priced\nBIGTHING-TASK: milestone=6 task=4 status=in_progress agent=-\nBIGTHING-TASK: milestone=6 status=done");
        assert_eq!(tasks, vec![
            TaskLine { milestone: 6, task: 3, status: TaskStatus::Done, agent: Some("6.3-pricing".into()), note: "priced".into() },
            TaskLine { milestone: 6, task: 4, status: TaskStatus::InProgress, agent: None, note: String::new() },
        ]);
    }

    #[test]
    fn a_plan_block_is_read_with_its_tasks_and_bounded() {
        let reply = "Here is the plan.\n\nBIGTHING-PLAN\nmilestone: Foundation\ndetail: Set up the project.\ndetail: Second line.\nsection: `## Setup`\ncheck: tests_pass pnpm test\nstep: Scaffold\nstep: Wire CI\ndepends: 1\ncapability: Review\nmilestone: Art\ncheck: rm -rf ~\nEND-BIGTHING-PLAN";
        let plan = parse_plan(reply).unwrap();
        assert_eq!(plan.milestones.len(), 2);
        let first = &plan.milestones[0];
        assert_eq!(first.detail, "Set up the project.\nSecond line.");
        assert_eq!(first.section.as_deref(), Some("## Setup"));
        assert_eq!((first.check_kind, first.check_spec.as_deref()), (CheckKind::TestsPass, Some("pnpm test")));
        assert_eq!(first.steps[1], ProposedTask { title: "Wire CI".into(), depends: vec![1], capability: Some("review".into()) });
        assert_eq!(plan.milestones[1].check_kind, CheckKind::Manual, "an unnamed check is never a command");
        assert!(plan.notes.iter().any(|note| note.contains("does not name one of")));
        assert!(parse_plan("no block").is_none());
        assert!(parse_plan("BIGTHING-PLAN\nmilestone: unterminated").is_none());
    }

    #[test]
    fn an_amendment_is_read_resolved_and_diffed() {
        let reply = "I can fit the ships in.\n\nBIGTHING-AMEND\nadd: Ship art pipeline\nafter: 2\ncheck: tests_pass pnpm test\nstep: Import the sprites\nstep: Bind them\nrevise: 3\ntitle: Economy with ship classes\ndrop: 3\nreason: folded into the milestone above\ndrop: the economy one\nEND-BIGTHING-AMEND";
        let amendment = parse_amendment(reply).unwrap();
        assert_eq!(amendment.ops.len(), 3);
        assert!(matches!(&amendment.ops[0], AmendOp::Add { after: Place::After(2), check_kind: CheckKind::TestsPass, steps, .. } if steps.len() == 2));
        assert!(amendment.notes.join(" ").contains("rather than a milestone number"));
        let decorated = "**BIGTHING-AMEND**\n- **add:** First\n**END-BIGTHING-AMEND**\n\nActually:\n\nODYSSEY-AMEND\nadd: Second\nEND-BIGTHING-AMEND";
        assert!(matches!(&parse_amendment(decorated).unwrap().ops[..], [AmendOp::Add { title, .. }] if title == "Second"));
        assert!(parse_amendment("BIGTHING-AMEND\nreason: orphan\nEND-BIGTHING-AMEND").is_none());

        let mut done = step("s1", StepState::Done);
        done.title = "Done task".into();
        let mut m2 = milestone("m2", MilestoneState::Active);
        m2.title = "Domain".into();
        m2.steps = vec![done, step("s2", StepState::Pending)];
        let plan = vec![milestone("m1", MilestoneState::Verified), m2, milestone("m3", MilestoneState::Planned)];
        let ops = vec![
            AmendOp::Revise { target: 1, title: Some("x".into()), detail: None, section: None, check_kind: None, check_spec: None, steps: vec![] },
            AmendOp::DropTask { task: TaskRef { milestone: 2, task: 1 }, reason: String::new() },
            AmendOp::Drop { target: 9, reason: String::new() },
            AmendOp::SplitTask { task: TaskRef { milestone: 2, task: 2 }, steps: vec![ProposedTask { title: "only one".into(), ..Default::default() }], reason: String::new() },
            AmendOp::MoveTask { task: TaskRef { milestone: 2, task: 2 }, after: start(), reason: "first".into() },
        ];
        let resolved = resolve_ops(&ops, &plan);
        assert!(resolved[0].refused.as_deref().unwrap().contains("already verified"));
        assert!(resolved[1].refused.as_deref().unwrap().contains("is done"));
        assert_eq!(resolved[2].refused.as_deref(), Some("there is no milestone 9"));
        assert!(resolved[3].refused.as_deref().unwrap().contains("at least two"));
        assert_eq!(resolved[4].refused, None);
        let text = diff_text(&plan_diff(&resolved, &plan));
        assert!(text.contains("↕ Move task 2.2 \"s2\" to the start (first)"), "{text}");
        assert!(text.contains("— refused: there is no milestone 9"));
    }

    #[test]
    fn amendment_ops_round_trip_through_the_json_the_interface_wrote() {
        let written = r#"[{"op":"add","title":"Ships","detail":"","section":null,"checkKind":"manual","checkSpec":null,"steps":[{"title":"a","depends":[]}],"after":"end"},{"op":"move_task","ref":{"milestone":2,"task":3},"after":1,"reason":""},{"op":"revise","target":2,"title":null,"detail":"more","section":null,"checkKind":null,"checkSpec":null,"steps":[]}]"#;
        let ops: Vec<AmendOp> = serde_json::from_str(written).unwrap();
        assert!(matches!(ops[0], AmendOp::Add { after: Place::Named(PlaceName::End), .. }));
        assert!(matches!(ops[1], AmendOp::MoveTask { after: Place::After(1), .. }));
        assert!(!ops[2].is_milestone_scope());
        assert!(ops[0].is_milestone_scope());
        let again: Vec<AmendOp> = serde_json::from_str(&serde_json::to_string(&ops).unwrap()).unwrap();
        assert_eq!(again, ops);
    }

    #[test]
    fn tools_win_over_the_text_and_the_text_still_counts() {
        let text = "BIGTHING-REPORT: milestone=1 status=blocked note=from text\nBIGTHING-ASK: question=Q1?";
        let tools = TurnProtocol { report: Some(Report { milestone: 2, status: ReportStatus::Complete, note: "tool".into() }), asks: vec![Ask { kind: "ambiguity".into(), fallback: String::new(), options: vec![], question: "Q1?".into() }], ..Default::default() };
        let turn = TurnProtocol::read(text, tools);
        assert_eq!(turn.report.unwrap().milestone, 2);
        assert_eq!(turn.asks.len(), 1, "the same question by both routes is one question");
        assert_eq!(TurnProtocol::read(text, TurnProtocol::default()).report.unwrap().note, "from text");
    }

    #[test]
    fn tasks_are_listed_with_what_they_wait_on() {
        let mut first = step("a", StepState::Done);
        first.title = "First".into();
        let mut second = step("b", StepState::Pending);
        second.title = "Second".into();
        second.depends_on = vec!["c".into()];
        let mut third = step("c", StepState::Pending);
        third.title = "Third".into();
        third.agent_name = Some("6.3-x".into());
        let steps = vec![first, second, third];
        assert_eq!(task_lines_for(5, &steps), ["6.1 [done] First", "6.2 [waiting on 6.3] Second", "6.3 [ready] Third — 6.3-x"]);
        assert_eq!(ready_tasks(&steps), [2]);
        assert_eq!(read_depends("1, 3 6.2 x"), [1, 3, 2]);
    }
}
