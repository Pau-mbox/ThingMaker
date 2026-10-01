//! Super Thing goals: the record behind the long-horizon runner
//! (docs/plans/odyssey.md).
//!
//! This module only stores and reads. It never decides that a milestone is
//! done: `state` and `check_*` are written by callers that either ran a check
//! themselves, read an exit code out of the runtime's own tool record, or were
//! told by the user — and `check_source` says which of those it was, because
//! they are not equally strong evidence.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{Storage, StorageError, new_id, now_unix_ms};

macro_rules! string_enum {
    ($name:ident { $($variant:ident => $text:literal),+ $(,)? }, default $default:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }

            /// Unknown text falls back to the default rather than failing a
            /// read: a row written by a newer build must not make the screen
            /// unopenable.
            pub fn parse(value: &str) -> Self {
                match value {
                    $($text => Self::$variant,)+
                    _ => Self::$default,
                }
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::$default
            }
        }
    };
}

string_enum!(OdysseyState {
    Draft => "draft",
    Running => "running",
    WaitingUsage => "waiting_usage",
    Paused => "paused",
    Blocked => "blocked",
    Complete => "complete",
    Abandoned => "abandoned",
}, default Draft);

string_enum!(StopCondition {
    GoalComplete => "goal_complete",
    MilestoneComplete => "milestone_complete",
    Manual => "manual",
}, default GoalComplete);

string_enum!(OnUsageReset {
    ContinueAutomatically => "continue_automatically",
    NotifyOnly => "notify_only",
    Stop => "stop",
}, default NotifyOnly);

string_enum!(MilestoneState {
    Planned => "planned",
    Active => "active",
    Reported => "reported",
    Verified => "verified",
    Failed => "failed",
    Skipped => "skipped",
}, default Planned);

string_enum!(CheckKind {
    Manual => "manual",
    Command => "command",
    FilesExist => "files_exist",
    TestsPass => "tests_pass",
}, default Manual);

string_enum!(CheckSource {
    Desktop => "desktop",
    AgentToolResult => "agent_tool_result",
    User => "user",
}, default Desktop);

string_enum!(OnReport {
    Wait => "wait",
    Continue => "continue",
}, default Continue);

// What happens to a plan change the agent proposes: held as a diff for the
// user, or applied at once with the diff shown afterwards.
string_enum!(OnPlanChange {
    // Task-level changes land on their own; changes to what a milestone is
    // wait for the user. The default: housekeeping is not a decision.
    TasksAuto => "tasks_auto",
    Review => "review",
    Auto => "auto",
}, default TasksAuto);

// Which orchestrator a goal wants to run on
// (docs/plans/odyssey-second-orchestrator.md §2.5).
//
// `Claude` and `Codex` pin the goal to that subscription. `Either` starts
// where it is and moves when this account is spent and the other is not —
// worth it against a goal parked for five hours, and against nothing less.
string_enum!(Orchestrator {
    Claude => "claude",
    Codex => "codex",
    Either => "either",
}, default Claude);

string_enum!(PlanChangeState {
    Proposed => "proposed",
    Applied => "applied",
    Rejected => "rejected",
}, default Proposed);

string_enum!(QuestionState {
    Open => "open",
    Answered => "answered",
    Dismissed => "dismissed",
}, default Open);

string_enum!(AmendmentState {
    Pending => "pending",
    Told => "told",
    Applied => "applied",
    Discarded => "discarded",
}, default Pending);

string_enum!(JournalKind {
    Continuation => "continuation",
    Briefing => "briefing",
    Report => "report",
    Checkpoint => "checkpoint",
    Check => "check",
    Wait => "wait",
    Resume => "resume",
    Guard => "guard",
    State => "state",
    Plan => "plan",
}, default State);

string_enum!(StepState {
    Pending => "pending",
    InProgress => "in_progress",
    Done => "done",
    Blocked => "blocked",
}, default Pending);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OdysseyRecord {
    pub id: String,
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub title: String,
    pub brief: String,
    pub state: OdysseyState,
    pub stop_condition: StopCondition,
    pub on_usage_reset: OnUsageReset,
    /// Whether an unverified claim stops the run or it carries on.
    #[serde(default)]
    pub on_report: OnReport,
    /// Minutes of no events at all before a running turn is treated as dead
    /// and cancelled. 0 never cancels.
    #[serde(default)]
    pub dead_turn_minutes: i64,
    pub max_continuations: i64,
    pub continuations_used: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<i64>,
    pub tokens_used: i64,
    /// Where this goal's plan was read from (a file name), when one was given.
    /// The document itself is not in the view: it is read on demand, because
    /// it is large and only the planning prompt needs it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_source: Option<String>,
    /// Workspace-relative path to the document, when it is one the agent can
    /// open for itself. This is what the briefing cites.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_document_bytes: Option<i64>,
    /// The command the planner is told to use as each milestone's check when
    /// the document names nothing better — the project's test command. A plan
    /// with no runnable check waits for a human at every milestone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_check: Option<String>,
    /// Whether a plan change the agent proposes waits for the user.
    #[serde(default)]
    pub on_plan_change: OnPlanChange,
    /// Which orchestrator this goal runs on, and whether it may move.
    #[serde(default)]
    pub orchestrator: Orchestrator,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A plan change the agent proposed, held or applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanChangeRecord {
    pub id: String,
    pub odyssey_id: String,
    pub at: i64,
    /// The operations, JSON as the renderer wrote them.
    pub ops: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub state: PlanChangeState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_note: Option<String>,
}

/// A decision the agent handed to the user, with what it does meanwhile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionRecord {
    pub id: String,
    pub odyssey_id: String,
    pub at: i64,
    pub kind: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
    pub state: QuestionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewQuestion {
    pub odyssey_id: String,
    pub kind: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub fallback: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneRecord {
    pub id: String,
    pub odyssey_id: String,
    pub position: i64,
    pub title: String,
    pub detail: String,
    pub state: MilestoneState,
    pub check_kind: CheckKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_spec: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_ran_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_passed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_source: Option<CheckSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_at: Option<i64>,
    /// The model's own last claim about this milestone, kept as a claim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reported_note: Option<String>,
    /// Where in the plan document this milestone came from: a heading or a
    /// line range, so the agent reads two pages of it rather than all of it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    #[serde(default)]
    pub steps: Vec<StepRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepRecord {
    pub id: String,
    pub milestone_id: String,
    pub position: i64,
    pub title: String,
    pub state: StepState,
    pub note: String,
    #[serde(default)]
    pub detail: String,
    /// The subagent named for this task, by the agent or by the desktop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    /// What the desktop saw that subagent running on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Step ids this task waits for.
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
}

/// Editable task fields. Absent fields are left as they are.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepEdit {
    pub title: Option<String>,
    pub detail: Option<String>,
    pub depends_on: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub id: String,
    pub odyssey_id: String,
    pub at: i64,
    pub kind: JournalKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub milestone_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_id: Option<String>,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// A workspace-relative file or folder the agent can open itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmendmentRef {
    pub path: String,
    /// `file` or `directory`, as it was when it was added.
    pub kind: String,
    /// What was there: a size, or how many entries. For the prompt, so the
    /// model knows whether it is being pointed at one file or a folder of 48.
    pub detail: String,
}

/// Something the user wants folded into a running goal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmendmentRecord {
    pub id: String,
    pub odyssey_id: String,
    pub at: i64,
    pub note: String,
    /// Present only for a document outside the workspace, which the agent
    /// cannot open for itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_bytes: Option<i64>,
    #[serde(default)]
    pub refs: Vec<AmendmentRef>,
    pub state: AmendmentState,
    /// How many prompts have carried it. Repeating is bounded: a model that
    /// keeps declining should reach the user, not keep costing turns.
    #[serde(default)]
    pub tell_count: i64,
    /// The goal's `continuations_used` when it was last carried, so "how long
    /// ago" is measured in the model's turns rather than wall-clock time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub told_at_continuation: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub told_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled_at: Option<i64>,
    /// `change` expects a plan change back and is re-told until one comes;
    /// `note` is an instruction, carried once and closed as delivered.
    #[serde(default = "default_amendment_kind")]
    pub kind: String,
}

fn default_amendment_kind() -> String {
    "change".to_string()
}

/// A new amendment, as the command receives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAmendment {
    pub odyssey_id: String,
    pub note: String,
    #[serde(default)]
    pub document: Option<String>,
    #[serde(default)]
    pub document_source: Option<String>,
    #[serde(default)]
    pub refs: Vec<AmendmentRef>,
    #[serde(default)]
    pub kind: Option<String>,
}

/// One reading of the account's usage windows, taken while a goal ran, with
/// the session's cumulative token counters at that moment.
///
/// Consecutive samples inside one window are differenced to learn what the
/// window actually charges — whether cached input counts, and at what rate.
/// The runner took these readings every minute and discarded them; every
/// spend decision depended on a fact nobody had kept the evidence for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSample {
    pub id: i64,
    pub odyssey_id: String,
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary_used_percent: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary_reset_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary_used_percent: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary_reset_at: Option<i64>,
    pub calls: i64,
    pub paid_input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
}

/// A usage sample as the command receives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewUsageSample {
    pub odyssey_id: String,
    #[serde(default)]
    pub primary_used_percent: Option<i64>,
    #[serde(default)]
    pub primary_reset_at: Option<i64>,
    #[serde(default)]
    pub secondary_used_percent: Option<i64>,
    #[serde(default)]
    pub secondary_reset_at: Option<i64>,
    pub calls: i64,
    pub paid_input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
}

/// Everything the screen needs, in one read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OdysseyView {
    pub goal: OdysseyRecord,
    pub milestones: Vec<MilestoneRecord>,
    pub journal: Vec<JournalEntry>,
}

/// New goal, as the create command receives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewOdyssey {
    pub workspace_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub brief: String,
    #[serde(default)]
    pub stop_condition: StopCondition,
    #[serde(default)]
    pub on_usage_reset: OnUsageReset,
    #[serde(default)]
    pub on_report: OnReport,
    pub max_continuations: i64,
    #[serde(default)]
    pub token_budget: Option<i64>,
    /// A plan document to hand to the model, and where it came from. Super Thing
    /// does not read it for milestones; the session's model proposes those.
    #[serde(default)]
    pub plan_source: Option<String>,
    #[serde(default)]
    pub plan_document: Option<String>,
    #[serde(default)]
    pub plan_path: Option<String>,
    #[serde(default)]
    pub default_check: Option<String>,
}

/// Editable goal fields. Absent fields are left as they are.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalEdit {
    pub title: Option<String>,
    pub brief: Option<String>,
    pub stop_condition: Option<StopCondition>,
    pub on_usage_reset: Option<OnUsageReset>,
    pub on_report: Option<OnReport>,
    pub dead_turn_minutes: Option<i64>,
    pub max_continuations: Option<i64>,
    /// `Some(None)` clears the budget; absent leaves it alone.
    pub token_budget: Option<Option<i64>>,
    /// `Some(None)` clears the default check; absent leaves it alone.
    pub default_check: Option<Option<String>>,
    pub on_plan_change: Option<OnPlanChange>,
    pub orchestrator: Option<Orchestrator>,
}

/// Editable milestone fields. Absent fields are left as they are.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneEdit {
    pub title: Option<String>,
    pub detail: Option<String>,
    pub check_kind: Option<CheckKind>,
    pub check_spec: Option<Option<String>>,
    /// `Some(None)` clears the section reference; absent leaves it alone.
    pub section: Option<Option<String>>,
}

const GOAL_COLUMNS: &str = "id, workspace_id, session_id, title, brief, state, stop_condition, on_usage_reset, max_continuations, continuations_used, token_budget, tokens_used, created_at, updated_at, plan_source, LENGTH(plan_document), on_report, dead_turn_minutes, plan_path, default_check, on_plan_change, orchestrator";

fn goal_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OdysseyRecord> {
    let state: String = row.get(5)?;
    let stop: String = row.get(6)?;
    let reset: String = row.get(7)?;
    Ok(OdysseyRecord {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        session_id: row.get(2)?,
        title: row.get(3)?,
        brief: row.get(4)?,
        state: OdysseyState::parse(&state),
        stop_condition: StopCondition::parse(&stop),
        on_usage_reset: OnUsageReset::parse(&reset),
        max_continuations: row.get(8)?,
        continuations_used: row.get(9)?,
        token_budget: row.get(10)?,
        tokens_used: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        plan_source: row.get(14)?,
        plan_document_bytes: row.get(15)?,
        on_report: OnReport::parse(&row.get::<_, String>(16)?),
        dead_turn_minutes: row.get(17)?,
        plan_path: row.get(18)?,
        default_check: row.get(19)?,
        on_plan_change: OnPlanChange::parse(&row.get::<_, String>(20)?),
        orchestrator: Orchestrator::parse(&row.get::<_, String>(21)?),
    })
}

const AMENDMENT_COLUMNS: &str = "id, odyssey_id, at, note, document_source, LENGTH(document), refs, state, told_at, settled_at, tell_count, told_at_continuation, kind";

fn amendment_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AmendmentRecord> {
    let refs: String = row.get(6)?;
    let state: String = row.get(7)?;
    Ok(AmendmentRecord {
        id: row.get(0)?,
        odyssey_id: row.get(1)?,
        at: row.get(2)?,
        note: row.get(3)?,
        document_source: row.get(4)?,
        document_bytes: row.get(5)?,
        // A row written by a newer build, or by hand, must not break the list.
        refs: serde_json::from_str(&refs).unwrap_or_default(),
        state: AmendmentState::parse(&state),
        told_at: row.get(8)?,
        settled_at: row.get(9)?,
        tell_count: row.get(10)?,
        told_at_continuation: row.get(11)?,
        kind: row.get(12)?,
    })
}

const MILESTONE_COLUMNS: &str = "id, odyssey_id, position, title, detail, state, check_kind, check_spec, check_ran_at, check_passed, check_output, check_source, verified_at, reported_note, section";

fn milestone_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MilestoneRecord> {
    let state: String = row.get(5)?;
    let kind: String = row.get(6)?;
    let source: Option<String> = row.get(11)?;
    Ok(MilestoneRecord {
        id: row.get(0)?,
        odyssey_id: row.get(1)?,
        position: row.get(2)?,
        title: row.get(3)?,
        detail: row.get(4)?,
        state: MilestoneState::parse(&state),
        check_kind: CheckKind::parse(&kind),
        check_spec: row.get(7)?,
        check_ran_at: row.get(8)?,
        check_passed: row.get::<_, Option<i64>>(9)?.map(|value| value != 0),
        check_output: row.get(10)?,
        check_source: source.as_deref().map(CheckSource::parse),
        verified_at: row.get(12)?,
        reported_note: row.get(13)?,
        section: row.get(14)?,
        steps: Vec::new(),
    })
}

const PLAN_CHANGE_COLUMNS: &str = "id, odyssey_id, at, ops, summary, reason, state, decided_at, decision_note";

fn plan_change_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PlanChangeRecord> {
    let state: String = row.get(6)?;
    Ok(PlanChangeRecord {
        id: row.get(0)?,
        odyssey_id: row.get(1)?,
        at: row.get(2)?,
        ops: row.get(3)?,
        summary: row.get(4)?,
        reason: row.get(5)?,
        state: PlanChangeState::parse(&state),
        decided_at: row.get(7)?,
        decision_note: row.get(8)?,
    })
}

const QUESTION_COLUMNS: &str = "id, odyssey_id, at, kind, question, options, fallback, state, answer, answered_at";

fn question_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<QuestionRecord> {
    let options: String = row.get(5)?;
    let state: String = row.get(7)?;
    Ok(QuestionRecord {
        id: row.get(0)?,
        odyssey_id: row.get(1)?,
        at: row.get(2)?,
        kind: row.get(3)?,
        question: row.get(4)?,
        options: serde_json::from_str(&options).unwrap_or_default(),
        fallback: row.get(6)?,
        state: QuestionState::parse(&state),
        answer: row.get(8)?,
        answered_at: row.get(9)?,
    })
}

const STEP_COLUMNS: &str = "id, milestone_id, position, title, state, note, detail, agent_name, harness, model, depends_on, started_at, updated_at, finished_at";

fn step_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StepRecord> {
    let state: String = row.get(4)?;
    let depends: String = row.get(10)?;
    Ok(StepRecord {
        id: row.get(0)?,
        milestone_id: row.get(1)?,
        position: row.get(2)?,
        title: row.get(3)?,
        state: StepState::parse(&state),
        note: row.get(5)?,
        detail: row.get(6)?,
        agent_name: row.get(7)?,
        harness: row.get(8)?,
        model: row.get(9)?,
        // A row written by hand must not break the list.
        depends_on: serde_json::from_str(&depends).unwrap_or_default(),
        started_at: row.get(11)?,
        updated_at: row.get(12)?,
        finished_at: row.get(13)?,
    })
}

fn journal_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<JournalEntry> {
    let kind: String = row.get(3)?;
    Ok(JournalEntry {
        id: row.get(0)?,
        odyssey_id: row.get(1)?,
        at: row.get(2)?,
        kind: JournalKind::parse(&kind),
        milestone_id: row.get(4)?,
        baseline_id: row.get(5)?,
        summary: row.get(6)?,
        detail: row.get(7)?,
    })
}

/// How many journal entries a view carries. The screen shows the latest few;
/// the rest is available through `odyssey_journal`.
const VIEW_JOURNAL_LIMIT: usize = 50;

impl Storage {
    pub fn odyssey_create(&self, new: &NewOdyssey) -> Result<OdysseyRecord, StorageError> {
        let title = new.title.trim();
        if title.is_empty() {
            return Err(StorageError::Io("a goal needs a title".into()));
        }
        if new.max_continuations < 1 {
            return Err(StorageError::Io("a goal needs at least one continuation".into()));
        }
        let id = new_id();
        let now = now_unix_ms();
        self.conn().execute(
            "INSERT INTO odysseys (id, workspace_id, session_id, title, brief, state, stop_condition, on_usage_reset, max_continuations, token_budget, created_at, updated_at, plan_source, plan_document, on_report, plan_path, default_check)
             VALUES (?1, ?2, ?3, ?4, ?5, 'draft', ?6, ?7, ?8, ?9, ?10, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                id,
                new.workspace_id,
                new.session_id,
                title,
                new.brief.trim(),
                new.stop_condition.as_str(),
                new.on_usage_reset.as_str(),
                new.max_continuations,
                new.token_budget,
                now,
                new.plan_source.as_deref().map(str::trim).filter(|value| !value.is_empty()),
                new.plan_document.as_deref().filter(|value| !value.trim().is_empty()),
                new.on_report.as_str(),
                new.plan_path.as_deref().map(str::trim).filter(|value| !value.is_empty()),
                new.default_check.as_deref().map(str::trim).filter(|value| !value.is_empty()),
            ],
        )?;
        self.odyssey_get(&id)?.ok_or_else(|| StorageError::NotFound(format!("odyssey {id} not found")))
    }

    pub fn odyssey_get(&self, id: &str) -> Result<Option<OdysseyRecord>, StorageError> {
        Ok(self
            .conn()
            .query_row(&format!("SELECT {GOAL_COLUMNS} FROM odysseys WHERE id = ?1"), params![id], goal_row)
            .optional()?)
    }

    /// The live goal driving a session, if any. Complete and abandoned goals
    /// are excluded so a finished run does not reappear as the active one.
    pub fn odyssey_for_session(&self, session_id: &str) -> Result<Option<OdysseyRecord>, StorageError> {
        Ok(self
            .conn()
            .query_row(
                &format!(
                    "SELECT {GOAL_COLUMNS} FROM odysseys
                     WHERE session_id = ?1 AND state NOT IN ('complete', 'abandoned')
                     ORDER BY created_at DESC LIMIT 1"
                ),
                params![session_id],
                goal_row,
            )
            .optional()?)
    }

    /// Every goal id in the database, for tools that address a goal by prefix.
    pub fn odyssey_all_ids(&self) -> Result<Vec<String>, StorageError> {
        let mut statement = self.conn().prepare("SELECT id FROM odysseys ORDER BY created_at DESC")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn odyssey_list(&self, workspace_id: &str) -> Result<Vec<OdysseyRecord>, StorageError> {
        let mut statement = self
            .conn()
            .prepare(&format!("SELECT {GOAL_COLUMNS} FROM odysseys WHERE workspace_id = ?1 ORDER BY created_at DESC"))?;
        let rows = statement.query_map(params![workspace_id], goal_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Goal, milestones with their steps, and the tail of the journal.
    pub fn odyssey_view(&self, id: &str) -> Result<Option<OdysseyView>, StorageError> {
        let Some(goal) = self.odyssey_get(id)? else {
            return Ok(None);
        };
        let mut milestones = {
            let mut statement = self
                .conn()
                .prepare(&format!("SELECT {MILESTONE_COLUMNS} FROM odyssey_milestones WHERE odyssey_id = ?1 ORDER BY position"))?;
            let rows = statement.query_map(params![id], milestone_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for milestone in &mut milestones {
            let mut statement = self
                .conn()
                .prepare(&format!("SELECT {STEP_COLUMNS} FROM odyssey_steps WHERE milestone_id = ?1 ORDER BY position"))?;
            let rows = statement.query_map(params![milestone.id], step_row)?;
            milestone.steps = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        }
        Ok(Some(OdysseyView {
            goal,
            milestones,
            journal: self.odyssey_journal(id, VIEW_JOURNAL_LIMIT)?,
        }))
    }

    pub fn odyssey_edit_goal(&self, id: &str, edit: &GoalEdit) -> Result<OdysseyRecord, StorageError> {
        let existing = self.odyssey_get(id)?.ok_or_else(|| StorageError::NotFound(format!("odyssey {id} not found")))?;
        let title = match &edit.title {
            Some(value) if value.trim().is_empty() => return Err(StorageError::Io("a goal needs a title".into())),
            Some(value) => value.trim().to_string(),
            None => existing.title,
        };
        let max = edit.max_continuations.unwrap_or(existing.max_continuations);
        if max < 1 {
            return Err(StorageError::Io("a goal needs at least one continuation".into()));
        }
        self.conn().execute(
            "UPDATE odysseys SET title = ?2, brief = ?3, stop_condition = ?4, on_usage_reset = ?5, max_continuations = ?6, token_budget = ?7, updated_at = ?8, on_report = ?9, dead_turn_minutes = ?10, default_check = ?11, on_plan_change = ?12, orchestrator = ?13 WHERE id = ?1",
            params![
                id,
                title,
                edit.brief.as_deref().map(str::trim).unwrap_or(&existing.brief),
                edit.stop_condition.unwrap_or(existing.stop_condition).as_str(),
                edit.on_usage_reset.unwrap_or(existing.on_usage_reset).as_str(),
                max,
                edit.token_budget.unwrap_or(existing.token_budget),
                now_unix_ms(),
                edit.on_report.unwrap_or(existing.on_report).as_str(),
                edit.dead_turn_minutes.unwrap_or(existing.dead_turn_minutes).max(0),
                match &edit.default_check {
                    Some(value) => value.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(str::to_string),
                    None => existing.default_check,
                },
                edit.on_plan_change.unwrap_or(existing.on_plan_change).as_str(),
                edit.orchestrator.unwrap_or(existing.orchestrator).as_str(),
            ],
        )?;
        self.odyssey_get(id)?.ok_or_else(|| StorageError::NotFound(format!("odyssey {id} not found")))
    }

    /// Queues something for the model to fold into a running goal.
    ///
    /// Queued, not submitted: the session is usually mid-turn and the agent refuses
    /// a second prompt, so the runner carries this on its next one.
    pub fn amendment_add(&self, new: &NewAmendment) -> Result<AmendmentRecord, StorageError> {
        let note = new.note.trim();
        if note.is_empty() {
            return Err(StorageError::Io("an amendment needs a note saying what you want".into()));
        }
        let id = new_id();
        let refs = serde_json::to_string(&new.refs).map_err(|error| StorageError::Io(error.to_string()))?;
        self.conn().execute(
            "INSERT INTO odyssey_amendments (id, odyssey_id, at, note, document, document_source, refs, kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                new.odyssey_id,
                now_unix_ms(),
                note,
                new.document.as_deref().filter(|value| !value.trim().is_empty()),
                new.document_source.as_deref().map(str::trim).filter(|value| !value.is_empty()),
                refs,
                if new.kind.as_deref() == Some("note") { "note" } else { "change" },
            ],
        )?;
        self.amendment_get(&id)?.ok_or_else(|| StorageError::NotFound(format!("amendment {id} not found")))
    }

    pub fn amendment_get(&self, id: &str) -> Result<Option<AmendmentRecord>, StorageError> {
        Ok(self
            .conn()
            .query_row(&format!("SELECT {AMENDMENT_COLUMNS} FROM odyssey_amendments WHERE id = ?1"), params![id], amendment_row)
            .optional()?)
    }

    /// Every amendment for a goal, newest first.
    pub fn amendment_list(&self, odyssey_id: &str) -> Result<Vec<AmendmentRecord>, StorageError> {
        let mut statement = self
            .conn()
            .prepare(&format!("SELECT {AMENDMENT_COLUMNS} FROM odyssey_amendments WHERE odyssey_id = ?1 ORDER BY at DESC, rowid DESC"))?;
        let rows = statement.query_map(params![odyssey_id], amendment_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The inlined document, read only when the prompt that carries it is built.
    pub fn amendment_document(&self, id: &str) -> Result<Option<String>, StorageError> {
        Ok(self
            .conn()
            .query_row("SELECT document FROM odyssey_amendments WHERE id = ?1", params![id], |row| row.get::<_, Option<String>>(0))
            .optional()?
            .flatten())
    }

    /// Records that a prompt carried this amendment, counting the attempt.
    ///
    /// Separate from `amendment_set_state` because a telling is not just a
    /// state: it is the nth attempt, at a particular point in the run, and
    /// both of those decide whether to try again.
    /// A `change` becomes `told` and is asked again until answered; a `note`
    /// is delivered, and delivered is done.
    pub fn amendment_mark_told(&self, id: &str, continuations_used: i64) -> Result<(), StorageError> {
        let changed = self.conn().execute(
            "UPDATE odyssey_amendments SET state = CASE WHEN kind = 'note' THEN 'applied' ELSE 'told' END, told_at = ?2, told_at_continuation = ?3, tell_count = tell_count + 1,
                settled_at = CASE WHEN kind = 'note' THEN ?2 ELSE settled_at END WHERE id = ?1",
            params![id, now_unix_ms(), continuations_used],
        )?;
        if changed == 0 {
            return Err(StorageError::NotFound(format!("amendment {id} not found")));
        }
        Ok(())
    }

    /// Moves an amendment along: told to the model, acted on, or dropped.
    pub fn amendment_set_state(&self, id: &str, state: AmendmentState) -> Result<(), StorageError> {
        let now = now_unix_ms();
        let changed = self.conn().execute(
            "UPDATE odyssey_amendments SET state = ?2,
                told_at = CASE WHEN ?2 = 'told' THEN ?3 ELSE told_at END,
                settled_at = CASE WHEN ?2 IN ('applied', 'discarded') THEN ?3 ELSE settled_at END
             WHERE id = ?1",
            params![id, state.as_str(), now],
        )?;
        if changed == 0 {
            return Err(StorageError::NotFound(format!("amendment {id} not found")));
        }
        Ok(())
    }

    /// The desktop session row a goal hangs off, resolved from the agent's id.
    ///
    /// `odysseys.session_id` references `sessions(id)` — the desktop record —
    /// not the id the agent uses on the wire. The renderer only knows the
    /// agent's id, so every Super Thing command resolves it here; passing it
    /// straight through fails the foreign key. `create` upserts the row, under
    /// `provider`, for a session the desktop has not recorded yet.
    pub fn odyssey_session_row(
        &self,
        workspace_id: &str,
        agent_session_id: &str,
        create: Option<crate::agents::Provider>,
    ) -> Result<Option<String>, StorageError> {
        if let Some(existing) = self.session_by_agent_id(workspace_id, agent_session_id)? {
            return Ok(Some(existing.id));
        }
        let Some(provider) = create else {
            return Ok(None);
        };
        Ok(Some(self.session_upsert(workspace_id, agent_session_id, super::workspaces::SessionOrigin::Unknown, provider)?.id))
    }

    /// The stored plan document, read only when the planning prompt needs it.
    pub fn odyssey_plan_document(&self, id: &str) -> Result<Option<String>, StorageError> {
        Ok(self
            .conn()
            .query_row("SELECT plan_document FROM odysseys WHERE id = ?1", params![id], |row| row.get::<_, Option<String>>(0))
            .optional()?
            .flatten())
    }

    /// Attaches (or clears, with `None`) the plan document for a goal.
    pub fn odyssey_set_plan(&self, id: &str, source: Option<&str>, document: Option<&str>, path: Option<&str>) -> Result<(), StorageError> {
        let changed = self.conn().execute(
            "UPDATE odysseys SET plan_source = ?2, plan_document = ?3, updated_at = ?4, plan_path = ?5 WHERE id = ?1",
            params![
                id,
                source.map(str::trim).filter(|value| !value.is_empty()),
                document.filter(|value| !value.trim().is_empty()),
                now_unix_ms(),
                path.map(str::trim).filter(|value| !value.is_empty()),
            ],
        )?;
        if changed == 0 {
            return Err(StorageError::NotFound(format!("odyssey {id} not found")));
        }
        Ok(())
    }

    /// The summary prefix of the journal row a move writes. The runner reads
    /// it to decide that the new session has not been briefed yet, so it is a
    /// contract between the storage and `decide()`, not a label.
    pub const MOVED_TO_SESSION: &'static str = "Moved to session";

    /// Points a goal at a different session.
    ///
    /// A goal has exactly one session at a time, for the life of that session
    /// — but not for the life of the goal. Re-pointing is what makes a restart
    /// keep its run, and what failover is built out of: the record, the plan,
    /// the journal and `docs/super-thing/STATE.md` carry the run across, and the
    /// transcript does not (it never could — another orchestrator is a
    /// different account and a different program).
    ///
    /// The move is journalled with the new session's id and provider, because
    /// `decide()` briefs again after one: a session that was never told the
    /// goal cannot continue it.
    pub fn odyssey_repoint(&self, id: &str, session_id: &str) -> Result<OdysseyRecord, StorageError> {
        let goal = self.odyssey_get(id)?.ok_or_else(|| StorageError::NotFound(format!("odyssey {id} not found")))?;
        if goal.session_id.as_deref() == Some(session_id) {
            return Ok(goal);
        }
        let session: Option<(String, String, String)> = self
            .conn()
            .query_row(
                "SELECT id, workspace_id, provider FROM sessions WHERE id = ?1",
                params![session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((_, workspace_id, agent)) = session else {
            return Err(StorageError::NotFound(format!("session {session_id} not found")));
        };
        // A goal is a workspace's; moving it to a session in another workspace
        // would point the run at a different tree.
        if workspace_id != goal.workspace_id {
            return Err(StorageError::Invalid("a goal can only move to a session in its own workspace".into()));
        }
        // The live-goal-per-session index refuses a session that already has
        // one, and says so in the user's words rather than SQLite's.
        let taken: Option<String> = self
            .conn()
            .query_row(
                "SELECT id FROM odysseys WHERE session_id = ?1 AND id != ?2 AND state NOT IN ('complete', 'abandoned')",
                params![session_id, id],
                |row| row.get(0),
            )
            .optional()?;
        if taken.is_some() {
            return Err(StorageError::Conflict("that session is already running another goal".into()));
        }
        self.conn().execute(
            "UPDATE odysseys SET session_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, session_id, now_unix_ms()],
        )?;
        self.odyssey_journal_append(
            id,
            JournalKind::State,
            None,
            None,
            &format!("{} {session_id} ({agent})", Self::MOVED_TO_SESSION),
            Some(&format!("sessionId={session_id}\nagent={agent}\nfrom={}", goal.session_id.as_deref().unwrap_or("none"))),
        )?;
        self.odyssey_get(id)?.ok_or_else(|| StorageError::NotFound(format!("odyssey {id} not found")))
    }

    pub fn odyssey_set_state(&self, id: &str, state: OdysseyState) -> Result<(), StorageError> {
        let changed = self.conn().execute(
            "UPDATE odysseys SET state = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, state.as_str(), now_unix_ms()],
        )?;
        if changed == 0 {
            return Err(StorageError::NotFound(format!("odyssey {id} not found")));
        }
        Ok(())
    }

    /// Records one continuation and the tokens it cost. Both counters are the
    /// budget the screen shows, so they move together.
    pub fn odyssey_record_continuation(&self, id: &str, tokens: i64) -> Result<(), StorageError> {
        let changed = self.conn().execute(
            "UPDATE odysseys SET continuations_used = continuations_used + 1, tokens_used = tokens_used + ?2, updated_at = ?3 WHERE id = ?1",
            params![id, tokens.max(0), now_unix_ms()],
        )?;
        if changed == 0 {
            return Err(StorageError::NotFound(format!("odyssey {id} not found")));
        }
        Ok(())
    }

    pub fn odyssey_delete(&self, id: &str) -> Result<(), StorageError> {
        self.conn().execute("DELETE FROM odysseys WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn milestone_add(&self, odyssey_id: &str, title: &str, detail: &str, check_kind: CheckKind, check_spec: Option<&str>, section: Option<&str>) -> Result<MilestoneRecord, StorageError> {
        let title = title.trim();
        if title.is_empty() {
            return Err(StorageError::Io("a milestone needs a title".into()));
        }
        let next: i64 = self
            .conn()
            .query_row("SELECT COALESCE(MAX(position), -1) + 1 FROM odyssey_milestones WHERE odyssey_id = ?1", params![odyssey_id], |row| row.get(0))?;
        let id = new_id();
        self.conn().execute(
            "INSERT INTO odyssey_milestones (id, odyssey_id, position, title, detail, check_kind, check_spec, section) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, odyssey_id, next, title, detail.trim(), check_kind.as_str(), check_spec, section.map(str::trim).filter(|value| !value.is_empty())],
        )?;
        self.milestone_get(&id)?.ok_or_else(|| StorageError::NotFound(format!("milestone {id} not found")))
    }

    pub fn milestone_get(&self, id: &str) -> Result<Option<MilestoneRecord>, StorageError> {
        Ok(self
            .conn()
            .query_row(&format!("SELECT {MILESTONE_COLUMNS} FROM odyssey_milestones WHERE id = ?1"), params![id], milestone_row)
            .optional()?)
    }

    pub fn milestone_edit(&self, id: &str, edit: &MilestoneEdit) -> Result<MilestoneRecord, StorageError> {
        let existing = self.milestone_get(id)?.ok_or_else(|| StorageError::NotFound(format!("milestone {id} not found")))?;
        let title = match &edit.title {
            Some(value) if value.trim().is_empty() => return Err(StorageError::Io("a milestone needs a title".into())),
            Some(value) => value.trim().to_string(),
            None => existing.title,
        };
        self.conn().execute(
            "UPDATE odyssey_milestones SET title = ?2, detail = ?3, check_kind = ?4, check_spec = ?5, section = ?6 WHERE id = ?1",
            params![
                id,
                title,
                edit.detail.as_deref().map(str::trim).unwrap_or(&existing.detail),
                edit.check_kind.unwrap_or(existing.check_kind).as_str(),
                edit.check_spec.clone().unwrap_or(existing.check_spec),
                match &edit.section {
                    Some(value) => value.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(str::to_string),
                    None => existing.section,
                },
            ],
        )?;
        self.milestone_get(id)?.ok_or_else(|| StorageError::NotFound(format!("milestone {id} not found")))
    }

    /// Sets a milestone's state. `verified` also stamps `verified_at`; leaving
    /// `verified` clears it, so the badge can never outlive its evidence.
    pub fn milestone_set_state(&self, id: &str, state: MilestoneState) -> Result<(), StorageError> {
        let verified_at = (state == MilestoneState::Verified).then(now_unix_ms);
        let changed = self.conn().execute(
            "UPDATE odyssey_milestones SET state = ?2, verified_at = ?3 WHERE id = ?1",
            params![id, state.as_str(), verified_at],
        )?;
        if changed == 0 {
            return Err(StorageError::NotFound(format!("milestone {id} not found")));
        }
        Ok(())
    }

    /// Stores the model's own claim about a milestone. It moves the milestone
    /// to `reported`, never to `verified`.
    pub fn milestone_record_report(&self, id: &str, note: &str) -> Result<(), StorageError> {
        let changed = self.conn().execute(
            "UPDATE odyssey_milestones SET state = 'reported', reported_note = ?2 WHERE id = ?1",
            params![id, note.trim()],
        )?;
        if changed == 0 {
            return Err(StorageError::NotFound(format!("milestone {id} not found")));
        }
        Ok(())
    }

    /// Stores the outcome of a check and, when it passed, verifies the
    /// milestone. `source` records which lane produced the evidence.
    pub fn milestone_record_check(&self, id: &str, passed: bool, output: &str, source: CheckSource) -> Result<MilestoneRecord, StorageError> {
        let now = now_unix_ms();
        let state = if passed { MilestoneState::Verified } else { MilestoneState::Failed };
        let changed = self.conn().execute(
            "UPDATE odyssey_milestones SET state = ?2, check_ran_at = ?3, check_passed = ?4, check_output = ?5, check_source = ?6, verified_at = ?7 WHERE id = ?1",
            params![id, state.as_str(), now, i64::from(passed), output, source.as_str(), passed.then_some(now)],
        )?;
        if changed == 0 {
            return Err(StorageError::NotFound(format!("milestone {id} not found")));
        }
        self.milestone_get(id)?.ok_or_else(|| StorageError::NotFound(format!("milestone {id} not found")))
    }

    /// Rewrites the order from a complete list of ids. Positions are moved out
    /// of the way first because `UNIQUE (odyssey_id, position)` is checked per
    /// statement, so a straight renumber would collide mid-way.
    pub fn milestone_reorder(&self, odyssey_id: &str, ordered_ids: &[String]) -> Result<(), StorageError> {
        let existing: Vec<String> = {
            let mut statement = self.conn().prepare("SELECT id FROM odyssey_milestones WHERE odyssey_id = ?1")?;
            let rows = statement.query_map(params![odyssey_id], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        if existing.len() != ordered_ids.len() || !existing.iter().all(|id| ordered_ids.contains(id)) {
            return Err(StorageError::Io("reorder must list every milestone of the goal exactly once".into()));
        }
        let transaction = self.conn().unchecked_transaction()?;
        for (index, id) in ordered_ids.iter().enumerate() {
            transaction.execute(
                "UPDATE odyssey_milestones SET position = ?2 WHERE id = ?1 AND odyssey_id = ?3",
                params![id, -(index as i64) - 1, odyssey_id],
            )?;
        }
        for (index, id) in ordered_ids.iter().enumerate() {
            transaction.execute(
                "UPDATE odyssey_milestones SET position = ?2 WHERE id = ?1 AND odyssey_id = ?3",
                params![id, index as i64, odyssey_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Deletes a milestone and closes the gap in the order.
    pub fn milestone_delete(&self, id: &str) -> Result<(), StorageError> {
        let Some(milestone) = self.milestone_get(id)? else {
            return Ok(());
        };
        let transaction = self.conn().unchecked_transaction()?;
        transaction.execute("DELETE FROM odyssey_milestones WHERE id = ?1", params![id])?;
        transaction.execute(
            "UPDATE odyssey_milestones SET position = position - 1 WHERE odyssey_id = ?1 AND position > ?2",
            params![milestone.odyssey_id, milestone.position],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn step_add(&self, milestone_id: &str, title: &str, detail: &str, depends_on: &[String]) -> Result<StepRecord, StorageError> {
        let title = title.trim();
        if title.is_empty() {
            return Err(StorageError::Io("a task needs a title".into()));
        }
        let next: i64 = self
            .conn()
            .query_row("SELECT COALESCE(MAX(position), -1) + 1 FROM odyssey_steps WHERE milestone_id = ?1", params![milestone_id], |row| row.get(0))?;
        let id = new_id();
        let depends = serde_json::to_string(depends_on).map_err(|error| StorageError::Io(error.to_string()))?;
        self.conn().execute(
            "INSERT INTO odyssey_steps (id, milestone_id, position, title, detail, depends_on, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, milestone_id, next, title, detail.trim(), depends, now_unix_ms()],
        )?;
        self.step_get(&id)?.ok_or_else(|| StorageError::NotFound(format!("step {id} not found")))
    }

    pub fn step_get(&self, id: &str) -> Result<Option<StepRecord>, StorageError> {
        Ok(self
            .conn()
            .query_row(&format!("SELECT {STEP_COLUMNS} FROM odyssey_steps WHERE id = ?1"), params![id], step_row)
            .optional()?)
    }

    pub fn step_edit(&self, id: &str, edit: &StepEdit) -> Result<StepRecord, StorageError> {
        let existing = self.step_get(id)?.ok_or_else(|| StorageError::NotFound(format!("step {id} not found")))?;
        let title = match &edit.title {
            Some(value) if value.trim().is_empty() => return Err(StorageError::Io("a task needs a title".into())),
            Some(value) => value.trim().to_string(),
            None => existing.title,
        };
        let depends = serde_json::to_string(edit.depends_on.as_ref().unwrap_or(&existing.depends_on)).map_err(|error| StorageError::Io(error.to_string()))?;
        self.conn().execute(
            "UPDATE odyssey_steps SET title = ?2, detail = ?3, depends_on = ?4, updated_at = ?5 WHERE id = ?1",
            params![id, title, edit.detail.as_deref().map(str::trim).unwrap_or(&existing.detail), depends, now_unix_ms()],
        )?;
        self.step_get(id)?.ok_or_else(|| StorageError::NotFound(format!("step {id} not found")))
    }

    /// Moves a task and stamps the move: the first move into progress starts
    /// it, done or blocked finishes it, and reopening clears the finish.
    pub fn step_set_state(&self, id: &str, state: StepState, note: Option<&str>) -> Result<(), StorageError> {
        let now = now_unix_ms();
        let changed = self.conn().execute(
            "UPDATE odyssey_steps SET state = ?2, note = COALESCE(?3, note), updated_at = ?4,
                started_at = CASE WHEN ?2 IN ('in_progress', 'done', 'blocked') THEN COALESCE(started_at, ?4) ELSE started_at END,
                finished_at = CASE WHEN ?2 IN ('done', 'blocked') THEN ?4 ELSE NULL END
             WHERE id = ?1",
            params![id, state.as_str(), note, now],
        )?;
        if changed == 0 {
            return Err(StorageError::NotFound(format!("step {id} not found")));
        }
        Ok(())
    }

    /// Records who is doing a task: the subagent's name, and the harness and
    /// model the desktop saw it on. Any of them may be unknown yet; an absent
    /// value leaves what was recorded.
    pub fn step_assign(&self, id: &str, agent_name: Option<&str>, harness: Option<&str>, model: Option<&str>) -> Result<(), StorageError> {
        let changed = self.conn().execute(
            "UPDATE odyssey_steps SET agent_name = COALESCE(?2, agent_name), harness = COALESCE(?3, harness), model = COALESCE(?4, model), updated_at = ?5 WHERE id = ?1",
            params![id, agent_name.map(str::trim).filter(|value| !value.is_empty()), harness, model, now_unix_ms()],
        )?;
        if changed == 0 {
            return Err(StorageError::NotFound(format!("step {id} not found")));
        }
        Ok(())
    }

    pub fn step_delete(&self, id: &str) -> Result<(), StorageError> {
        self.conn().execute("DELETE FROM odyssey_steps WHERE id = ?1", params![id])?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn odyssey_journal_append(
        &self,
        odyssey_id: &str,
        kind: JournalKind,
        milestone_id: Option<&str>,
        baseline_id: Option<&str>,
        summary: &str,
        detail: Option<&str>,
    ) -> Result<JournalEntry, StorageError> {
        let id = new_id();
        let at = now_unix_ms();
        self.conn().execute(
            "INSERT INTO odyssey_journal (id, odyssey_id, at, kind, milestone_id, baseline_id, summary, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, odyssey_id, at, kind.as_str(), milestone_id, baseline_id, summary, detail],
        )?;
        Ok(JournalEntry {
            id,
            odyssey_id: odyssey_id.to_string(),
            at,
            kind,
            milestone_id: milestone_id.map(str::to_string),
            baseline_id: baseline_id.map(str::to_string),
            summary: summary.to_string(),
            detail: detail.map(str::to_string),
        })
    }

    /// Journal newest first. Two entries can share a millisecond, and a random
    /// id is not an order, so insertion order (`rowid`) breaks the tie — the
    /// screen's "latest" line has to be the one that actually happened last.
    pub fn odyssey_journal(&self, odyssey_id: &str, limit: usize) -> Result<Vec<JournalEntry>, StorageError> {
        let mut statement = self.conn().prepare(
            "SELECT id, odyssey_id, at, kind, milestone_id, baseline_id, summary, detail FROM odyssey_journal WHERE odyssey_id = ?1 ORDER BY at DESC, rowid DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![odyssey_id, limit as i64], journal_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Reorders a milestone's tasks; every task must be listed once.
    pub fn step_reorder(&self, milestone_id: &str, ordered_ids: &[String]) -> Result<(), StorageError> {
        let existing: Vec<String> = {
            let mut statement = self.conn().prepare("SELECT id FROM odyssey_steps WHERE milestone_id = ?1")?;
            let rows = statement.query_map(params![milestone_id], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        if existing.len() != ordered_ids.len() || !existing.iter().all(|id| ordered_ids.contains(id)) {
            return Err(StorageError::Io("reorder must list every task of the milestone exactly once".into()));
        }
        let transaction = self.conn().unchecked_transaction()?;
        for (index, id) in ordered_ids.iter().enumerate() {
            transaction.execute("UPDATE odyssey_steps SET position = ?2 WHERE id = ?1 AND milestone_id = ?3", params![id, -(index as i64) - 1, milestone_id])?;
        }
        for (index, id) in ordered_ids.iter().enumerate() {
            transaction.execute("UPDATE odyssey_steps SET position = ?2 WHERE id = ?1 AND milestone_id = ?3", params![id, index as i64, milestone_id])?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Holds a plan change the agent proposed.
    pub fn plan_change_add(&self, odyssey_id: &str, ops: &str, summary: &str, reason: Option<&str>, state: PlanChangeState) -> Result<PlanChangeRecord, StorageError> {
        let id = new_id();
        let at = now_unix_ms();
        self.conn().execute(
            "INSERT INTO odyssey_plan_changes (id, odyssey_id, at, ops, summary, reason, state, decided_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, odyssey_id, at, ops, summary, reason.map(str::trim).filter(|value| !value.is_empty()), state.as_str(), if state == PlanChangeState::Proposed { None } else { Some(at) }],
        )?;
        self.plan_change_get(&id)?.ok_or_else(|| StorageError::NotFound(format!("plan change {id} not found")))
    }

    pub fn plan_change_get(&self, id: &str) -> Result<Option<PlanChangeRecord>, StorageError> {
        Ok(self
            .conn()
            .query_row(&format!("SELECT {PLAN_CHANGE_COLUMNS} FROM odyssey_plan_changes WHERE id = ?1"), params![id], plan_change_row)
            .optional()?)
    }

    /// Plan changes newest first.
    pub fn plan_change_list(&self, odyssey_id: &str, limit: usize) -> Result<Vec<PlanChangeRecord>, StorageError> {
        let mut statement = self.conn().prepare(&format!("SELECT {PLAN_CHANGE_COLUMNS} FROM odyssey_plan_changes WHERE odyssey_id = ?1 ORDER BY at DESC, rowid DESC LIMIT ?2"))?;
        let rows = statement.query_map(params![odyssey_id, limit as i64], plan_change_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn plan_change_decide(&self, id: &str, state: PlanChangeState, note: Option<&str>) -> Result<(), StorageError> {
        let changed = self.conn().execute(
            "UPDATE odyssey_plan_changes SET state = ?2, decided_at = ?3, decision_note = ?4 WHERE id = ?1",
            params![id, state.as_str(), now_unix_ms(), note.map(str::trim).filter(|value| !value.is_empty())],
        )?;
        if changed == 0 {
            return Err(StorageError::NotFound(format!("plan change {id} not found")));
        }
        Ok(())
    }

    /// Records a question the agent handed to the user.
    pub fn question_add(&self, new: &NewQuestion) -> Result<QuestionRecord, StorageError> {
        let question = new.question.trim();
        if question.is_empty() {
            return Err(StorageError::Io("a question needs text".into()));
        }
        let id = new_id();
        let options = serde_json::to_string(&new.options).map_err(|error| StorageError::Io(error.to_string()))?;
        self.conn().execute(
            "INSERT INTO odyssey_questions (id, odyssey_id, at, kind, question, options, fallback) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, new.odyssey_id, now_unix_ms(), new.kind.trim(), question, options, new.fallback.as_deref().map(str::trim).filter(|value| !value.is_empty())],
        )?;
        self.question_get(&id)?.ok_or_else(|| StorageError::NotFound(format!("question {id} not found")))
    }

    pub fn question_get(&self, id: &str) -> Result<Option<QuestionRecord>, StorageError> {
        Ok(self
            .conn()
            .query_row(&format!("SELECT {QUESTION_COLUMNS} FROM odyssey_questions WHERE id = ?1"), params![id], question_row)
            .optional()?)
    }

    /// Questions newest first.
    pub fn question_list(&self, odyssey_id: &str, limit: usize) -> Result<Vec<QuestionRecord>, StorageError> {
        let mut statement = self.conn().prepare(&format!("SELECT {QUESTION_COLUMNS} FROM odyssey_questions WHERE odyssey_id = ?1 ORDER BY at DESC, rowid DESC LIMIT ?2"))?;
        let rows = statement.query_map(params![odyssey_id, limit as i64], question_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Answers a question, or dismisses it without an answer.
    pub fn question_settle(&self, id: &str, state: QuestionState, answer: Option<&str>) -> Result<(), StorageError> {
        let changed = self.conn().execute(
            "UPDATE odyssey_questions SET state = ?2, answer = ?3, answered_at = ?4 WHERE id = ?1",
            params![id, state.as_str(), answer.map(str::trim).filter(|value| !value.is_empty()), now_unix_ms()],
        )?;
        if changed == 0 {
            return Err(StorageError::NotFound(format!("question {id} not found")));
        }
        Ok(())
    }

    /// Records a usage reading for a running goal.
    ///
    /// A reading identical to the newest one (same percentages, same token
    /// counters) is not stored twice: the sampler fires every minute whether
    /// or not anything moved, and a flat line carries no information.
    pub fn usage_sample_add(&self, new: &NewUsageSample) -> Result<Option<UsageSample>, StorageError> {
        let latest = self.usage_samples(&new.odyssey_id, 1)?.pop();
        if let Some(latest) = latest {
            let same = latest.primary_used_percent == new.primary_used_percent
                && latest.primary_reset_at == new.primary_reset_at
                && latest.secondary_used_percent == new.secondary_used_percent
                && latest.secondary_reset_at == new.secondary_reset_at
                && latest.calls == new.calls
                && latest.paid_input_tokens == new.paid_input_tokens
                && latest.cached_input_tokens == new.cached_input_tokens
                && latest.output_tokens == new.output_tokens;
            if same {
                return Ok(None);
            }
        }
        let at = now_unix_ms();
        self.conn().execute(
            "INSERT INTO odyssey_usage_samples (odyssey_id, at, primary_used_percent, primary_reset_at, secondary_used_percent, secondary_reset_at, calls, paid_input_tokens, cached_input_tokens, output_tokens, reasoning_tokens)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                new.odyssey_id,
                at,
                new.primary_used_percent,
                new.primary_reset_at,
                new.secondary_used_percent,
                new.secondary_reset_at,
                new.calls,
                new.paid_input_tokens,
                new.cached_input_tokens,
                new.output_tokens,
                new.reasoning_tokens,
            ],
        )?;
        let id = self.conn().last_insert_rowid();
        Ok(Some(UsageSample {
            id,
            odyssey_id: new.odyssey_id.clone(),
            at,
            primary_used_percent: new.primary_used_percent,
            primary_reset_at: new.primary_reset_at,
            secondary_used_percent: new.secondary_used_percent,
            secondary_reset_at: new.secondary_reset_at,
            calls: new.calls,
            paid_input_tokens: new.paid_input_tokens,
            cached_input_tokens: new.cached_input_tokens,
            output_tokens: new.output_tokens,
            reasoning_tokens: new.reasoning_tokens,
        }))
    }

    /// Usage samples newest first, bounded.
    pub fn usage_samples(&self, odyssey_id: &str, limit: usize) -> Result<Vec<UsageSample>, StorageError> {
        let mut statement = self.conn().prepare(
            "SELECT id, odyssey_id, at, primary_used_percent, primary_reset_at, secondary_used_percent, secondary_reset_at, calls, paid_input_tokens, cached_input_tokens, output_tokens, reasoning_tokens
             FROM odyssey_usage_samples WHERE odyssey_id = ?1 ORDER BY at DESC, id DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![odyssey_id, limit as i64], |row| {
            Ok(UsageSample {
                id: row.get(0)?,
                odyssey_id: row.get(1)?,
                at: row.get(2)?,
                primary_used_percent: row.get(3)?,
                primary_reset_at: row.get(4)?,
                secondary_used_percent: row.get(5)?,
                secondary_reset_at: row.get(6)?,
                calls: row.get(7)?,
                paid_input_tokens: row.get(8)?,
                cached_input_tokens: row.get(9)?,
                output_tokens: row.get(10)?,
                reasoning_tokens: row.get(11)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn goal(storage: &Storage) -> (String, OdysseyRecord) {
        let workspace = storage.workspace_upsert("/p", "/p", "w-1").unwrap();
        let record = storage
            .odyssey_create(&NewOdyssey {
                workspace_id: workspace.id.clone(),
                session_id: None,
                title: "  Ship onboarding v2  ".into(),
                brief: "Design and implement onboarding.".into(),
                stop_condition: StopCondition::GoalComplete,
                on_usage_reset: OnUsageReset::NotifyOnly,
                on_report: OnReport::default(),
                max_continuations: 10,
                token_budget: Some(200_000),
                plan_source: None,
                plan_document: None,
                plan_path: None,
                default_check: None,
            })
            .unwrap();
        (workspace.id, record)
    }

    #[test]
    fn a_goal_hangs_off_the_desktop_session_row_not_the_agents_own_id() {
        // The bug this guards: the renderer only knows the agent's id, and passing
        // it straight into `session_id` fails the foreign key, so creating a
        // goal from the screen died with "FOREIGN KEY constraint failed".
        let storage = Storage::open_in_memory().unwrap();
        let workspace = storage.workspace_upsert("/p", "/p", "w-1").unwrap();
        let session = storage.session_upsert(&workspace.id, "s-live", super::super::workspaces::SessionOrigin::Desktop, crate::agents::Provider::Claude).unwrap();
        assert_ne!(session.id, "s-live", "the desktop row has its own id");

        let new = |session_id: Option<String>| NewOdyssey {
            workspace_id: workspace.id.clone(),
            session_id,
            title: "Ship it".into(),
            brief: String::new(),
            stop_condition: StopCondition::default(),
            on_usage_reset: OnUsageReset::default(),
            on_report: OnReport::default(),
            max_continuations: 10,
            token_budget: None,
            plan_source: None,
            plan_document: None,
            plan_path: None,
            default_check: None,
        };
        assert!(storage.odyssey_create(&new(Some("s-live".into()))).is_err(), "the agent's id is not a session row");

        let resolved = storage.odyssey_session_row(&workspace.id, "s-live", None).unwrap();
        assert_eq!(resolved.as_deref(), Some(session.id.as_str()));
        let created = storage.odyssey_create(&new(resolved)).unwrap();
        assert_eq!(storage.odyssey_for_session(&session.id).unwrap().map(|goal| goal.id), Some(created.id));
    }

    #[test]
    fn a_goal_moves_to_another_session_and_the_move_is_in_the_record() {
        // Re-pointing is what makes a restart keep its run: the plan, the
        // journal and the workspace notes carry across, the transcript does
        // not. The journal row is also what tells the runner to brief again.
        use super::super::workspaces::SessionOrigin;
        use crate::agents::Provider;
        let storage = Storage::open_in_memory().unwrap();
        let (workspace_id, goal) = goal(&storage);
        let fresh = storage.session_upsert(&workspace_id, "cc-1", SessionOrigin::Desktop, Provider::Claude).unwrap();
        assert_eq!(fresh.provider, Provider::Claude);

        let moved = storage.odyssey_repoint(&goal.id, &fresh.id).unwrap();
        assert_eq!(moved.session_id.as_deref(), Some(fresh.id.as_str()));
        let latest = storage.odyssey_journal(&goal.id, 5).unwrap();
        assert!(latest[0].summary.starts_with(Storage::MOVED_TO_SESSION), "{}", latest[0].summary);
        assert!(latest[0].summary.contains("(claude)"), "the move names the account it went to");
        assert_eq!(storage.odyssey_for_session(&fresh.id).unwrap().map(|row| row.id), Some(goal.id.clone()));

        // Moving to where it already is changes nothing and journals nothing:
        // a no-op move that re-briefed would cost a continuation for nothing.
        let again = storage.odyssey_repoint(&goal.id, &fresh.id).unwrap();
        assert_eq!(again.session_id, moved.session_id);
        assert_eq!(storage.odyssey_journal(&goal.id, 5).unwrap().len(), latest.len());
    }

    #[test]
    fn a_goal_cannot_move_onto_another_live_goals_session_or_out_of_its_workspace() {
        use super::super::workspaces::SessionOrigin;
        let storage = Storage::open_in_memory().unwrap();
        let (workspace_id, first) = goal(&storage);
        let second_session = storage.session_upsert(&workspace_id, "s-2", SessionOrigin::Desktop, crate::agents::Provider::Claude).unwrap();
        let second = storage
            .odyssey_create(&NewOdyssey {
                workspace_id: workspace_id.clone(),
                session_id: Some(second_session.id.clone()),
                title: "Another".into(),
                brief: String::new(),
                stop_condition: StopCondition::default(),
                on_usage_reset: OnUsageReset::default(),
                on_report: OnReport::default(),
                max_continuations: 10,
                token_budget: None,
                plan_source: None,
                plan_document: None,
                plan_path: None,
                default_check: None,
            })
            .unwrap();
        assert!(storage.odyssey_repoint(&first.id, &second_session.id).is_err(), "that session already has a live goal");

        // Once the other goal is finished the session is free again.
        storage.odyssey_set_state(&second.id, OdysseyState::Complete).unwrap();
        assert!(storage.odyssey_repoint(&first.id, &second_session.id).is_ok());

        let elsewhere = storage.workspace_upsert("/other", "/other", "w-2").unwrap();
        let foreign = storage.session_upsert(&elsewhere.id, "s-foreign", SessionOrigin::Desktop, crate::agents::Provider::Claude).unwrap();
        assert!(storage.odyssey_repoint(&first.id, &foreign.id).is_err(), "a goal stays in its own tree");
    }

    #[test]
    fn resolving_a_session_row_creates_one_only_when_asked() {
        // A read must not invent a session row; creating a goal for a session
        // the catalog has not reconciled yet must be able to.
        let storage = Storage::open_in_memory().unwrap();
        let workspace = storage.workspace_upsert("/p", "/p", "w-1").unwrap();

        use crate::agents::Provider;
        assert_eq!(storage.odyssey_session_row(&workspace.id, "s-new", None).unwrap(), None);
        assert!(storage.session_by_agent_id(&workspace.id, "s-new").unwrap().is_none(), "looking did not create it");

        let created = storage.odyssey_session_row(&workspace.id, "s-new", Some(Provider::Claude)).unwrap().expect("created");
        assert_eq!(storage.session_by_agent_id(&workspace.id, "s-new").unwrap().map(|row| row.id), Some(created.clone()));
        // And it is idempotent: asking again returns the same row.
        assert_eq!(storage.odyssey_session_row(&workspace.id, "s-new", Some(Provider::Claude)).unwrap(), Some(created));
    }

    #[test]
    fn a_dead_turn_limit_defaults_generously_and_can_be_switched_off() {
        let storage = Storage::open_in_memory().unwrap();
        let (_, record) = goal(&storage);
        // Generous on purpose: a long silent tool call is legitimate, and this
        // is for turns that are dead rather than turns that are slow.
        assert_eq!(record.dead_turn_minutes, 30);

        let off = storage.odyssey_edit_goal(&record.id, &GoalEdit { dead_turn_minutes: Some(0), ..Default::default() }).unwrap();
        assert_eq!(off.dead_turn_minutes, 0);
        // A negative value would be a cancel-everything trap.
        let clamped = storage.odyssey_edit_goal(&record.id, &GoalEdit { dead_turn_minutes: Some(-5), ..Default::default() }).unwrap();
        assert_eq!(clamped.dead_turn_minutes, 0);
    }

    #[test]
    fn an_unverified_claim_carries_on_by_default_and_the_choice_is_editable() {
        let storage = Storage::open_in_memory().unwrap();
        let (_, record) = goal(&storage);
        // A runner that halts at every milestone is not a long-horizon runner,
        // so carrying on is the default; it never means "verified".
        assert_eq!(record.on_report, OnReport::Continue);

        let edited = storage
            .odyssey_edit_goal(&record.id, &GoalEdit { on_report: Some(OnReport::Wait), ..Default::default() })
            .unwrap();
        assert_eq!(edited.on_report, OnReport::Wait);
        // And editing something else leaves it alone.
        let again = storage.odyssey_edit_goal(&record.id, &GoalEdit { title: Some("Renamed".into()), ..Default::default() }).unwrap();
        assert_eq!(again.on_report, OnReport::Wait);
    }

    #[test]
    fn an_amendment_is_queued_with_its_references_and_read_back() {
        let storage = Storage::open_in_memory().unwrap();
        let (_, goal) = goal(&storage);
        let record = storage
            .amendment_add(&NewAmendment {
                odyssey_id: goal.id.clone(),
                note: "  Generate the ships and embed them  ".into(),
                document: Some("# Ships\n\nOne per class.".into()),
                document_source: Some("ships.md".into()),
                refs: vec![AmendmentRef {
                    path: "Assets/Art/Ships".into(),
                    kind: "directory".into(),
                    detail: "48 files".into(),
                }],
                kind: None,
            })
            .unwrap();

        assert_eq!(record.note, "Generate the ships and embed them");
        assert_eq!(record.state, AmendmentState::Pending);
        assert_eq!(record.refs.len(), 1);
        assert_eq!(record.refs[0].path, "Assets/Art/Ships");
        // The document rides in the list as a size, and is read on demand.
        assert_eq!(record.document_bytes, Some("# Ships\n\nOne per class.".len() as i64));
        assert_eq!(storage.amendment_document(&record.id).unwrap().as_deref(), Some("# Ships\n\nOne per class."));
        assert_eq!(storage.amendment_list(&goal.id).unwrap().len(), 1);
    }

    #[test]
    fn an_amendment_needs_something_to_ask_for() {
        let storage = Storage::open_in_memory().unwrap();
        let (_, goal) = goal(&storage);
        let blank = NewAmendment { odyssey_id: goal.id, note: "   ".into(), document: None, document_source: None, refs: vec![], kind: None };
        assert!(matches!(storage.amendment_add(&blank), Err(StorageError::Io(_))));
    }

    #[test]
    fn every_telling_is_counted_and_placed_in_the_run() {
        // One telling was the bug: an amendment carried on a single prompt and
        // never mentioned again is forgotten as soon as that prompt compacts
        // out of context.
        let storage = Storage::open_in_memory().unwrap();
        let (_, goal) = goal(&storage);
        let record = storage
            .amendment_add(&NewAmendment { odyssey_id: goal.id, note: "add the ships".into(), document: None, document_source: None, refs: vec![], kind: None })
            .unwrap();
        assert_eq!(record.tell_count, 0);
        assert_eq!(record.told_at_continuation, None);

        storage.amendment_mark_told(&record.id, 11).unwrap();
        let first = storage.amendment_get(&record.id).unwrap().unwrap();
        assert_eq!((first.state, first.tell_count, first.told_at_continuation), (AmendmentState::Told, 1, Some(11)));

        storage.amendment_mark_told(&record.id, 15).unwrap();
        let second = storage.amendment_get(&record.id).unwrap().unwrap();
        assert_eq!((second.tell_count, second.told_at_continuation), (2, Some(15)));
    }

    #[test]
    fn an_amendment_records_when_it_was_told_and_when_it_settled() {
        let storage = Storage::open_in_memory().unwrap();
        let (_, goal) = goal(&storage);
        let record = storage
            .amendment_add(&NewAmendment { odyssey_id: goal.id.clone(), note: "add the ships".into(), document: None, document_source: None, refs: vec![], kind: None })
            .unwrap();
        assert_eq!(record.told_at, None);

        storage.amendment_set_state(&record.id, AmendmentState::Told).unwrap();
        let told = storage.amendment_get(&record.id).unwrap().unwrap();
        assert!(told.told_at.is_some());
        assert_eq!(told.settled_at, None);

        storage.amendment_set_state(&record.id, AmendmentState::Applied).unwrap();
        let applied = storage.amendment_get(&record.id).unwrap().unwrap();
        assert_eq!(applied.state, AmendmentState::Applied);
        assert_eq!(applied.told_at, told.told_at, "being acted on does not rewrite when it was told");
        assert!(applied.settled_at.is_some());
    }

    #[test]
    fn amendments_go_with_the_goal_they_belong_to() {
        let storage = Storage::open_in_memory().unwrap();
        let (_, goal) = goal(&storage);
        storage
            .amendment_add(&NewAmendment { odyssey_id: goal.id.clone(), note: "one".into(), document: None, document_source: None, refs: vec![], kind: None })
            .unwrap();
        storage.odyssey_delete(&goal.id).unwrap();
        assert!(storage.amendment_list(&goal.id).unwrap().is_empty());
    }

    #[test]
    fn a_plan_document_is_stored_whole_and_read_back_on_demand() {
        let storage = Storage::open_in_memory().unwrap();
        let workspace = storage.workspace_upsert("/p", "/p", "w-1").unwrap();
        let document = "# Roadmap\n\n## Phase one\nDo the thing.\n";
        let record = storage
            .odyssey_create(&NewOdyssey {
                workspace_id: workspace.id,
                session_id: None,
                title: "From a roadmap".into(),
                brief: String::new(),
                stop_condition: StopCondition::default(),
                on_usage_reset: OnUsageReset::default(),
                on_report: OnReport::default(),
                max_continuations: 10,
                token_budget: None,
                plan_source: Some("  roadmap.md  ".into()),
                plan_document: Some(document.into()),
                plan_path: Some("docs/roadmap.md".into()),
                default_check: None,
            })
            .unwrap();

        // The view carries only the metadata; the text is read separately.
        assert_eq!(record.plan_source.as_deref(), Some("roadmap.md"));
        assert_eq!(record.plan_document_bytes, Some(document.len() as i64));
        assert_eq!(storage.odyssey_plan_document(&record.id).unwrap().as_deref(), Some(document));
        // A path is what the briefing cites; the text is the fallback for a
        // document the agent cannot open for itself.
        assert_eq!(record.plan_path.as_deref(), Some("docs/roadmap.md"));
        // And no milestones: reading it is the model's job, not the parser's.
        assert!(storage.odyssey_view(&record.id).unwrap().unwrap().milestones.is_empty());

        storage.odyssey_set_plan(&record.id, None, None, None).unwrap();
        assert_eq!(storage.odyssey_plan_document(&record.id).unwrap(), None);
        assert_eq!(storage.odyssey_get(&record.id).unwrap().unwrap().plan_source, None);
    }

    #[test]
    fn a_blank_plan_document_is_stored_as_absent() {
        let storage = Storage::open_in_memory().unwrap();
        let (_, record) = goal(&storage);
        storage.odyssey_set_plan(&record.id, Some("  "), Some("   \n "), Some(" ")).unwrap();
        assert_eq!(storage.odyssey_plan_document(&record.id).unwrap(), None);
        assert_eq!(storage.odyssey_get(&record.id).unwrap().unwrap().plan_source, None);
    }

    #[test]
    fn creates_a_goal_with_trimmed_text_and_safe_defaults() {
        let storage = Storage::open_in_memory().unwrap();
        let (_, record) = goal(&storage);
        assert_eq!(record.title, "Ship onboarding v2");
        assert_eq!(record.state, OdysseyState::Draft, "a new goal never starts running");
        assert_eq!(record.continuations_used, 0);
        assert_eq!(record.tokens_used, 0);
        assert_eq!(record.token_budget, Some(200_000));
        assert!(matches!(
            storage.odyssey_create(&NewOdyssey {
                workspace_id: record.workspace_id.clone(),
                session_id: None,
                title: "   ".into(),
                brief: String::new(),
                stop_condition: StopCondition::default(),
                on_usage_reset: OnUsageReset::default(),
                on_report: OnReport::default(),
                max_continuations: 10,
                token_budget: None,
                plan_source: None,
                plan_document: None,
                plan_path: None,
                default_check: None,
            }),
            Err(StorageError::Io(_))
        ));
    }

    #[test]
    fn milestones_append_reorder_and_close_their_gap() {
        let storage = Storage::open_in_memory().unwrap();
        let (_, record) = goal(&storage);
        let first = storage.milestone_add(&record.id, "Audit existing flow", "", CheckKind::Manual, None, None).unwrap();
        let second = storage.milestone_add(&record.id, "Define acceptance tests", "", CheckKind::TestsPass, Some("pnpm test"), None).unwrap();
        let third = storage.milestone_add(&record.id, "Build screens", "", CheckKind::Manual, None, None).unwrap();
        assert_eq!((first.position, second.position, third.position), (0, 1, 2));

        storage.milestone_reorder(&record.id, &[third.id.clone(), first.id.clone(), second.id.clone()]).unwrap();
        let view = storage.odyssey_view(&record.id).unwrap().unwrap();
        assert_eq!(view.milestones.iter().map(|m| m.title.as_str()).collect::<Vec<_>>(), vec!["Build screens", "Audit existing flow", "Define acceptance tests"]);
        assert_eq!(view.milestones.iter().map(|m| m.position).collect::<Vec<_>>(), vec![0, 1, 2]);

        // A partial list is refused rather than silently renumbering.
        assert!(matches!(storage.milestone_reorder(&record.id, std::slice::from_ref(&third.id)), Err(StorageError::Io(_))));

        storage.milestone_delete(&first.id).unwrap();
        let view = storage.odyssey_view(&record.id).unwrap().unwrap();
        assert_eq!(view.milestones.iter().map(|m| m.position).collect::<Vec<_>>(), vec![0, 1], "the gap closes");
    }

    #[test]
    fn a_report_is_a_claim_and_only_a_check_verifies() {
        let storage = Storage::open_in_memory().unwrap();
        let (_, record) = goal(&storage);
        let milestone = storage.milestone_add(&record.id, "Define acceptance tests", "", CheckKind::TestsPass, Some("pnpm test"), None).unwrap();

        storage.milestone_record_report(&milestone.id, "  wrote them all  ").unwrap();
        let reported = storage.milestone_get(&milestone.id).unwrap().unwrap();
        assert_eq!(reported.state, MilestoneState::Reported, "the model's claim does not verify anything");
        assert_eq!(reported.reported_note.as_deref(), Some("wrote them all"));
        assert_eq!(reported.verified_at, None);

        let failed = storage.milestone_record_check(&milestone.id, false, "exit 1: 2 failed", CheckSource::Desktop).unwrap();
        assert_eq!(failed.state, MilestoneState::Failed);
        assert_eq!(failed.verified_at, None, "a failed check leaves no verification stamp");
        assert_eq!(failed.check_source, Some(CheckSource::Desktop));

        let passed = storage.milestone_record_check(&milestone.id, true, "exit 0: 25 passed", CheckSource::AgentToolResult).unwrap();
        assert_eq!(passed.state, MilestoneState::Verified);
        assert!(passed.verified_at.is_some());
        assert_eq!(passed.check_source, Some(CheckSource::AgentToolResult), "the lane is part of the evidence");

        // Moving away from verified drops the stamp with it.
        storage.milestone_set_state(&milestone.id, MilestoneState::Active).unwrap();
        assert_eq!(storage.milestone_get(&milestone.id).unwrap().unwrap().verified_at, None);
    }

    #[test]
    fn one_live_goal_per_session_but_finished_ones_stay() {
        let storage = Storage::open_in_memory().unwrap();
        let workspace = storage.workspace_upsert("/p", "/p", "w-1").unwrap();
        let session = storage.session_upsert(&workspace.id, "s-1", super::super::workspaces::SessionOrigin::Desktop, crate::agents::Provider::Claude).unwrap();
        let new = |title: &str| NewOdyssey {
            workspace_id: workspace.id.clone(),
            session_id: Some(session.id.clone()),
            title: title.into(),
            brief: String::new(),
            stop_condition: StopCondition::default(),
            on_usage_reset: OnUsageReset::default(),
            on_report: OnReport::default(),
            max_continuations: 10,
            token_budget: None,
            plan_source: None,
            plan_document: None,
            plan_path: None,
            default_check: None,
        };
        let first = storage.odyssey_create(&new("First goal")).unwrap();
        assert!(storage.odyssey_create(&new("Second goal")).is_err(), "a session drives one live goal");

        storage.odyssey_set_state(&first.id, OdysseyState::Complete).unwrap();
        let second = storage.odyssey_create(&new("Second goal")).unwrap();
        assert_eq!(storage.odyssey_for_session(&session.id).unwrap().unwrap().id, second.id);
        assert_eq!(storage.odyssey_list(&workspace.id).unwrap().len(), 2, "the finished goal is still on record");
    }

    #[test]
    fn the_view_carries_steps_and_the_journal_newest_first() {
        let storage = Storage::open_in_memory().unwrap();
        let (_, record) = goal(&storage);
        let milestone = storage.milestone_add(&record.id, "Build screens", "detail", CheckKind::Manual, None, None).unwrap();
        storage.step_add(&milestone.id, "Set up components", "", &[]).unwrap();
        let second = storage.step_add(&milestone.id, "Implement screens", "", &[]).unwrap();
        storage.step_set_state(&second.id, StepState::InProgress, Some("paused for usage")).unwrap();
        storage.odyssey_journal_append(&record.id, JournalKind::Briefing, None, None, "Briefed the session", None).unwrap();
        storage.odyssey_journal_append(&record.id, JournalKind::Checkpoint, Some(&milestone.id), None, "12 files", Some("welcome screen")).unwrap();

        let view = storage.odyssey_view(&record.id).unwrap().unwrap();
        assert_eq!(view.milestones.len(), 1);
        assert_eq!(view.milestones[0].steps.iter().map(|s| s.title.as_str()).collect::<Vec<_>>(), vec!["Set up components", "Implement screens"]);
        assert_eq!(view.milestones[0].steps[1].state, StepState::InProgress);
        assert_eq!(view.milestones[0].steps[1].note, "paused for usage");
        assert_eq!(view.journal.first().map(|entry| entry.kind), Some(JournalKind::Checkpoint), "newest first");
        assert_eq!(view.journal.len(), 2);
    }

    #[test]
    fn budget_counters_move_together_and_edits_keep_unset_fields() {
        let storage = Storage::open_in_memory().unwrap();
        let (_, record) = goal(&storage);
        storage.odyssey_record_continuation(&record.id, 4_200).unwrap();
        storage.odyssey_record_continuation(&record.id, 1_800).unwrap();
        let after = storage.odyssey_get(&record.id).unwrap().unwrap();
        assert_eq!((after.continuations_used, after.tokens_used), (2, 6_000));

        let edited = storage
            .odyssey_edit_goal(
                &record.id,
                &GoalEdit {
                    on_usage_reset: Some(OnUsageReset::ContinueAutomatically),
                    token_budget: Some(None),
                    ..GoalEdit::default()
                },
            )
            .unwrap();
        assert_eq!(edited.title, "Ship onboarding v2", "an absent field is left alone");
        assert_eq!(edited.on_usage_reset, OnUsageReset::ContinueAutomatically);
        assert_eq!(edited.token_budget, None, "Some(None) clears the budget");
        assert_eq!(edited.max_continuations, 10);
        assert!(matches!(
            storage.odyssey_edit_goal(&record.id, &GoalEdit { max_continuations: Some(0), ..GoalEdit::default() }),
            Err(StorageError::Io(_))
        ));
    }

    #[test]
    fn deleting_a_goal_takes_its_milestones_steps_and_journal() {
        let storage = Storage::open_in_memory().unwrap();
        let (_, record) = goal(&storage);
        let milestone = storage.milestone_add(&record.id, "Build screens", "", CheckKind::Manual, None, None).unwrap();
        storage.step_add(&milestone.id, "Set up components", "", &[]).unwrap();
        storage.odyssey_journal_append(&record.id, JournalKind::State, None, None, "started", None).unwrap();

        storage.odyssey_delete(&record.id).unwrap();

        assert!(storage.odyssey_get(&record.id).unwrap().is_none());
        assert!(storage.milestone_get(&milestone.id).unwrap().is_none());
        assert!(storage.odyssey_journal(&record.id, 10).unwrap().is_empty());
    }

    #[test]
    fn an_unknown_enum_value_reads_as_the_default_instead_of_failing() {
        // A row written by a newer build must not make the screen unopenable.
        assert_eq!(OdysseyState::parse("time_travelling"), OdysseyState::Draft);
        assert_eq!(CheckKind::parse("vibes"), CheckKind::Manual);
        assert_eq!(MilestoneState::parse("almost"), MilestoneState::Planned);
    }

    #[test]
    fn usage_samples_are_kept_in_order_and_a_flat_reading_is_not_stored_twice() {
        let storage = Storage::open_in_memory().unwrap();
        let (_, record) = goal(&storage);
        let reading = |pct: i64, paid: i64| NewUsageSample {
            odyssey_id: record.id.clone(),
            primary_used_percent: Some(pct),
            primary_reset_at: Some(1_700_000_000),
            secondary_used_percent: Some(10),
            secondary_reset_at: Some(1_700_500_000),
            calls: 3,
            paid_input_tokens: paid,
            cached_input_tokens: 40_000,
            output_tokens: 900,
            reasoning_tokens: 300,
        };
        assert!(storage.usage_sample_add(&reading(20, 5_000)).unwrap().is_some());
        // The sampler fires every minute; a reading that moved nothing is noise.
        assert!(storage.usage_sample_add(&reading(20, 5_000)).unwrap().is_none());
        assert!(storage.usage_sample_add(&reading(23, 9_000)).unwrap().is_some());

        let samples = storage.usage_samples(&record.id, 10).unwrap();
        assert_eq!(samples.len(), 2);
        assert_eq!(samples[0].primary_used_percent, Some(23), "newest first");
        assert_eq!(samples[1].paid_input_tokens, 5_000);
    }

    #[test]
    fn a_goal_carries_its_default_check_and_a_milestone_its_section() {
        let storage = Storage::open_in_memory().unwrap();
        let (_, record) = goal(&storage);
        assert_eq!(record.default_check, None);
        let edited = storage
            .odyssey_edit_goal(&record.id, &GoalEdit { default_check: Some(Some("  pnpm test  ".into())), ..Default::default() })
            .unwrap();
        assert_eq!(edited.default_check.as_deref(), Some("pnpm test"));
        // Clearing is explicit; an absent field leaves it alone.
        let same = storage.odyssey_edit_goal(&record.id, &GoalEdit { title: Some("Renamed".into()), ..Default::default() }).unwrap();
        assert_eq!(same.default_check.as_deref(), Some("pnpm test"));
        let cleared = storage.odyssey_edit_goal(&record.id, &GoalEdit { default_check: Some(None), ..Default::default() }).unwrap();
        assert_eq!(cleared.default_check, None);

        let milestone = storage.milestone_add(&record.id, "Economy", "detail", CheckKind::TestsPass, Some("pnpm test"), Some(" §4 Economy ")).unwrap();
        assert_eq!(milestone.section.as_deref(), Some("§4 Economy"));
        let revised = storage.milestone_edit(&milestone.id, &MilestoneEdit { section: Some(None), ..Default::default() }).unwrap();
        assert_eq!(revised.section, None);
        let view = storage.odyssey_view(&record.id).unwrap().unwrap();
        assert_eq!(view.milestones[0].check_spec.as_deref(), Some("pnpm test"));
    }

    #[test]
    fn a_task_keeps_its_owner_its_dependencies_and_the_times_it_moved() {
        let storage = Storage::open_in_memory().unwrap();
        let (_, record) = goal(&storage);
        let milestone = storage.milestone_add(&record.id, "Economy", "", CheckKind::Manual, None, None).unwrap();
        let first = storage.step_add(&milestone.id, "Design the model", "Cities, goods.", &[]).unwrap();
        let second = storage.step_add(&milestone.id, "Implement pricing", "", std::slice::from_ref(&first.id)).unwrap();
        assert_eq!(second.depends_on, vec![first.id.clone()]);
        assert_eq!(second.detail, "");
        assert!(second.updated_at.is_some());
        assert_eq!((second.started_at, second.finished_at), (None, None));

        storage.step_set_state(&second.id, StepState::InProgress, None).unwrap();
        let running = storage.step_get(&second.id).unwrap().unwrap();
        assert!(running.started_at.is_some());
        assert_eq!(running.finished_at, None);

        storage.step_assign(&second.id, Some("6.2-pricing"), Some("acp.claude"), Some("sonnet")).unwrap();
        // An unknown value leaves what was recorded.
        storage.step_assign(&second.id, None, None, Some("opus")).unwrap();
        let owned = storage.step_get(&second.id).unwrap().unwrap();
        assert_eq!((owned.agent_name.as_deref(), owned.harness.as_deref(), owned.model.as_deref()), (Some("6.2-pricing"), Some("acp.claude"), Some("opus")));

        storage.step_set_state(&second.id, StepState::Done, Some("prices converge")).unwrap();
        let done = storage.step_get(&second.id).unwrap().unwrap();
        assert!(done.finished_at.is_some());
        assert_eq!(done.note, "prices converge");
        // Reopening clears the finish but keeps the start.
        storage.step_set_state(&second.id, StepState::Pending, None).unwrap();
        let reopened = storage.step_get(&second.id).unwrap().unwrap();
        assert_eq!(reopened.finished_at, None);
        assert_eq!(reopened.started_at, running.started_at);

        let edited = storage.step_edit(&first.id, &StepEdit { detail: Some("Cities, regions, goods.".into()), ..Default::default() }).unwrap();
        assert_eq!(edited.detail, "Cities, regions, goods.");
        let view = storage.odyssey_view(&record.id).unwrap().unwrap();
        assert_eq!(view.milestones[0].steps[1].depends_on, vec![first.id]);
    }

    #[test]
    fn a_proposed_plan_change_is_held_until_decided_and_a_question_until_answered() {
        let storage = Storage::open_in_memory().unwrap();
        let (_, record) = goal(&storage);
        assert_eq!(record.on_plan_change, OnPlanChange::TasksAuto);
        let auto = storage.odyssey_edit_goal(&record.id, &GoalEdit { on_plan_change: Some(OnPlanChange::Auto), ..Default::default() }).unwrap();
        assert_eq!(auto.on_plan_change, OnPlanChange::Auto);

        let change = storage.plan_change_add(&record.id, "[{\"op\":\"drop_task\"}]", "− 7.4 drop Docs", Some("folded into 7.3"), PlanChangeState::Proposed).unwrap();
        assert_eq!((change.state, change.decided_at), (PlanChangeState::Proposed, None));
        storage.plan_change_decide(&change.id, PlanChangeState::Rejected, Some("keep it")).unwrap();
        let decided = storage.plan_change_get(&change.id).unwrap().unwrap();
        assert_eq!((decided.state, decided.decision_note.as_deref()), (PlanChangeState::Rejected, Some("keep it")));
        assert!(decided.decided_at.is_some());
        // One applied straight away is stamped at once.
        let applied = storage.plan_change_add(&record.id, "[]", "~ 7.1 revise", None, PlanChangeState::Applied).unwrap();
        assert!(applied.decided_at.is_some());
        assert_eq!(storage.plan_change_list(&record.id, 10).unwrap().len(), 2);

        let question = storage
            .question_add(&NewQuestion { odyssey_id: record.id.clone(), kind: "architecture".into(), question: "ECS or plain classes for the economy?".into(), options: vec!["ECS".into(), "classes".into()], fallback: Some("continuing with classes".into()) })
            .unwrap();
        assert_eq!((question.state, question.options.len()), (QuestionState::Open, 2));
        storage.question_settle(&question.id, QuestionState::Answered, Some("classes")).unwrap();
        let answered = storage.question_get(&question.id).unwrap().unwrap();
        assert_eq!((answered.state, answered.answer.as_deref()), (QuestionState::Answered, Some("classes")));
        assert!(storage.question_add(&NewQuestion { odyssey_id: record.id.clone(), kind: "x".into(), question: "  ".into(), options: vec![], fallback: None }).is_err());
    }

    #[test]
    fn tasks_can_be_reordered_within_a_milestone() {
        let storage = Storage::open_in_memory().unwrap();
        let (_, record) = goal(&storage);
        let milestone = storage.milestone_add(&record.id, "Economy", "", CheckKind::Manual, None, None).unwrap();
        let a = storage.step_add(&milestone.id, "A", "", &[]).unwrap();
        let b = storage.step_add(&milestone.id, "B", "", &[]).unwrap();
        let c = storage.step_add(&milestone.id, "C", "", &[]).unwrap();
        storage.step_reorder(&milestone.id, &[c.id.clone(), a.id.clone(), b.id.clone()]).unwrap();
        let view = storage.odyssey_view(&record.id).unwrap().unwrap();
        assert_eq!(view.milestones[0].steps.iter().map(|step| step.title.as_str()).collect::<Vec<_>>(), ["C", "A", "B"]);
        assert!(storage.step_reorder(&milestone.id, std::slice::from_ref(&a.id)).is_err(), "every task must be listed");
    }

    #[test]
    fn a_note_to_the_agent_is_delivered_once_and_never_becomes_a_stuck_change() {
        let storage = Storage::open_in_memory().unwrap();
        let (_, record) = goal(&storage);
        let note = storage
            .amendment_add(&NewAmendment { odyssey_id: record.id.clone(), note: "Do not block on quota.".into(), document: None, document_source: None, refs: vec![], kind: Some("note".into()) })
            .unwrap();
        assert_eq!(note.kind, "note");
        storage.amendment_mark_told(&note.id, 3).unwrap();
        let delivered = storage.amendment_get(&note.id).unwrap().unwrap();
        assert_eq!((delivered.state, delivered.tell_count), (AmendmentState::Applied, 1));
        assert!(delivered.settled_at.is_some());
        let change = storage
            .amendment_add(&NewAmendment { odyssey_id: record.id.clone(), note: "Add ships.".into(), document: None, document_source: None, refs: vec![], kind: None })
            .unwrap();
        assert_eq!(change.kind, "change");
        storage.amendment_mark_told(&change.id, 3).unwrap();
        assert_eq!(storage.amendment_get(&change.id).unwrap().unwrap().state, AmendmentState::Told);
    }
}
