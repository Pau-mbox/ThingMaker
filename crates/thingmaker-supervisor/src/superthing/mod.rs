//! Super Thing: the long-horizon runner (ADR-010).
//!
//! The engine owns the loop and writes every decision to the goal's record
//! before acting on it. The pieces it is built from are pure and tested on
//! their own:
//!
//! - [`decide`]: the one action to take, and when to move accounts;
//! - [`journal`]: the guards, read back out of the record;
//! - [`usage`]: what each account's windows say, and the rules for reading them;
//! - [`protocol`]: what the agent sends back, through tools or text;
//! - [`prompt`]: the briefing, the continuations and the planning prompt;
//! - [`evidence`]: an agent-run check, read out of the turn's own tool results;
//! - [`clock`]: wall-clock times in the machine's zone.
//!
//! Around them: [`engine`] (the loop), [`watch`] (one per session),
//! [`tools`] (the protocol and the memory on the `team` server),
//! [`dispatch`] (the plan handed to the team), [`spend`] (the forecast),
//! [`worktree`] (a run's own branch) and [`apply`] (plan changes into the
//! record).

pub use engine::{Engine, MoveTarget, TICK_INTERVAL};
pub use host::{EngineEvent, EngineHost, LiveSession, OpenSpec, RuntimeView};

pub mod apply;
pub mod clock;
pub mod decide;
pub mod dispatch;
pub mod engine;
pub mod evidence;
pub mod host;
pub mod journal;
pub mod prompt;
pub mod protocol;
pub mod skill;
pub mod spend;
pub mod tools;
pub mod usage;
pub mod watch;
pub mod worktree;

#[cfg(test)]
pub(crate) mod tests {
    use crate::storage::odyssey::{
        CheckKind, MilestoneRecord, MilestoneState, OdysseyRecord, OdysseyState, OnPlanChange, OnReport, OnUsageReset, Orchestrator, StepRecord, StepState, StopCondition,
    };

    pub fn goal() -> OdysseyRecord {
        OdysseyRecord {
            id: "o1".into(),
            workspace_id: "w1".into(),
            session_id: Some("s1".into()),
            title: "Ship onboarding v2".into(),
            brief: String::new(),
            state: OdysseyState::Running,
            stop_condition: StopCondition::GoalComplete,
            on_usage_reset: OnUsageReset::NotifyOnly,
            on_report: OnReport::Continue,
            dead_turn_minutes: 30,
            max_continuations: 50,
            continuations_used: 3,
            token_budget: None,
            tokens_used: 1_000,
            plan_source: None,
            plan_path: None,
            plan_document_bytes: None,
            default_check: None,
            on_plan_change: OnPlanChange::Review,
            orchestrator: Orchestrator::Codex,
            dispatch: Default::default(),
            review_tasks: false,
            isolate: false,
            source_workspace_id: None,
            worktree_path: None,
            branch: None,
            base_ref: None,
            account_policy: Default::default(),
            team: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    pub fn milestone(id: &str, state: MilestoneState) -> MilestoneRecord {
        MilestoneRecord {
            id: id.into(),
            odyssey_id: "o1".into(),
            position: 0,
            title: id.into(),
            detail: String::new(),
            state,
            check_kind: CheckKind::Manual,
            check_spec: None,
            check_ran_at: None,
            check_passed: None,
            check_output: None,
            check_source: None,
            verified_at: None,
            reported_note: None,
            section: None,
            steps: Vec::new(),
        }
    }

    pub fn step(id: &str, state: StepState) -> StepRecord {
        StepRecord {
            id: id.into(),
            milestone_id: "m".into(),
            position: 0,
            title: id.into(),
            state,
            note: String::new(),
            detail: String::new(),
            agent_name: None,
            harness: None,
            model: None,
            depends_on: Vec::new(),
            started_at: None,
            updated_at: None,
            finished_at: None,
            capability: None,
            job_id: None,
            review: None,
        }
    }
}
