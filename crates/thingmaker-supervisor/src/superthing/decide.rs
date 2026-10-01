//! The runner's decisions.
//!
//! Pure on purpose: given a goal, its milestones, its journal, what the
//! session is doing and what the account last said, it returns the one action
//! to take. The engine performs it. Every guard that stands between a goal and
//! the user's quota is decided here, so it is tested without a provider.

use std::collections::HashMap;

use super::{
    clock, journal,
    usage::{UsageSnapshot, UsageVerdict, usage_verdict},
};
use crate::agents::Provider;
use crate::storage::odyssey::{CheckKind, JournalEntry, MilestoneRecord, MilestoneState, OdysseyRecord, OdysseyState, OnReport, Orchestrator, StopCondition};

/// The least time between two prompts for one goal, from the journal.
pub const PROMPT_COOLDOWN_MS: i64 = 5_000;
/// Consecutive turns that change nothing before the run is blocked.
pub const STALE_TURN_LIMIT: usize = 3;
/// Consecutive prompts accepted and never answered before the run is blocked.
pub const UNANSWERED_LIMIT: usize = 3;
/// Consecutive ticks that threw before submitting anything.
pub const TICK_FAILURE_LIMIT: usize = 3;
/// How long the runner may be unable to act before that is reported.
pub const STALL_WARNING_MS: i64 = 5 * 60_000;
/// The least time between two moves of one goal: a move costs a briefing.
pub const FAILOVER_COOLDOWN_MS: i64 = 60 * 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionCondition {
    pub attached: bool,
    pub idle: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    /// Submit the briefing: this session has not been told the goal.
    Brief,
    /// Submit a continuation for this milestone.
    Continue { index: usize },
    /// Every milestone is settled.
    Complete,
    /// Park until the provider's quota resets.
    WaitUsage { resume_at: Option<i64>, reason: String },
    /// Stop and ask the user.
    Block { reason: String },
    /// A claim something has to verify.
    AwaitVerification { index: usize },
    /// Nothing to do right now, and nothing wrong.
    Idle { reason: String },
}

/// Whether Super Thing can settle this milestone itself.
pub fn has_runnable_check(milestone: &MilestoneRecord) -> bool {
    milestone.check_kind != CheckKind::Manual && milestone.check_spec.as_deref().is_some_and(|spec| !spec.trim().is_empty())
}

/// The milestone to work. With `skip_unchecked_claims`, a claim only a human
/// could verify is stepped over; a claim with a runnable check never is.
pub fn active_milestone(milestones: &[MilestoneRecord], skip_unchecked_claims: bool) -> Option<usize> {
    milestones.iter().position(|milestone| match milestone.state {
        MilestoneState::Active | MilestoneState::Failed | MilestoneState::Planned => true,
        MilestoneState::Reported => !skip_unchecked_claims || has_runnable_check(milestone),
        _ => false,
    })
}

/// `1,000`: how a number reads in a sentence.
pub fn grouped(value: i64) -> String {
    let digits = value.unsigned_abs().to_string();
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    if value < 0 { format!("-{out}") } else { out }
}

/// What the engine knows that the record does not, for one decision.
#[derive(Debug, Clone, Default)]
pub struct Extra {
    /// Open jobs the runner itself dispatched for the active milestone, by
    /// task number. While any is open the orchestrator is not prompted.
    pub dispatched_open: Vec<String>,
}

/// The next action for a goal. Guards run in order, so a run out of budget is
/// reported as out of budget rather than as whatever else is also true.
pub fn decide(goal: &OdysseyRecord, milestones: &[MilestoneRecord], journal_entries: &[JournalEntry], session: SessionCondition, usage: Option<&UsageSnapshot>, now: i64, extra: &Extra) -> Decision {
    if goal.state != OdysseyState::Running {
        return Decision::Idle { reason: format!("the goal is {}", goal.state.as_str()) };
    }
    if milestones.is_empty() {
        return Decision::Block { reason: "the goal has no milestones".into() };
    }
    // Facts about the account and the budget come first: they are true
    // whatever the session is doing.
    if goal.continuations_used >= goal.max_continuations {
        return Decision::Block { reason: format!("the continuation limit of {} is used up", goal.max_continuations) };
    }
    if let Some(budget) = goal.token_budget
        && goal.tokens_used >= budget
    {
        return Decision::Block { reason: format!("the token budget of {} is used up", grouped(budget)) };
    }
    if let UsageVerdict::Exhausted { resume_at, reason } = usage_verdict(usage) {
        return Decision::WaitUsage { resume_at, reason };
    }
    let stale = journal::stale_checkpoint_run(journal_entries);
    if stale >= STALE_TURN_LIMIT {
        return Decision::Block { reason: format!("{stale} turns in a row changed nothing on disk and nothing in the plan") };
    }
    let unanswered = journal::unanswered_run(journal_entries);
    if unanswered >= UNANSWERED_LIMIT {
        return Decision::Block { reason: format!("{unanswered} prompts in a row were accepted but never answered; the session is not reaching a model") };
    }
    let failed = journal::failed_tick_run(journal_entries);
    if failed >= TICK_FAILURE_LIMIT {
        return Decision::Block { reason: format!("{failed} ticks in a row failed before a prompt could be sent; this needs a look rather than another try") };
    }

    // The session: "not right now", the weakest reasons.
    if !session.attached {
        return Decision::Idle { reason: "the session is not attached".into() };
    }
    if !session.idle {
        return Decision::Idle { reason: "a turn is already running".into() };
    }
    if let Some(since) = journal::last_prompt_at(journal_entries)
        && now - since < PROMPT_COOLDOWN_MS
    {
        return Decision::Idle { reason: "waiting out the cooldown after the last prompt".into() };
    }
    if let Some(hold) = journal::held_until(journal_entries)
        && now < hold
    {
        return Decision::Idle { reason: format!("the agent is waiting for its delegates' quota; the next continuation goes out at {}", clock::local_hhmm(hold)) };
    }

    let carry_on = goal.on_report != OnReport::Wait;
    let Some(index) = active_milestone(milestones, carry_on) else { return Decision::Complete };

    if !journal::briefed_this_session(journal_entries) {
        return Decision::Brief;
    }
    if milestones[index].state == MilestoneState::Reported {
        return Decision::AwaitVerification { index };
    }
    if !extra.dispatched_open.is_empty() {
        return Decision::Idle { reason: format!("workers are on task{} {}", if extra.dispatched_open.len() == 1 { "" } else { "s" }, extra.dispatched_open.join(", ")) };
    }
    Decision::Continue { index }
}

/// Every account's last known state, by provider.
pub type AccountUsage = HashMap<Provider, UsageSnapshot>;

#[derive(Debug, Clone, PartialEq)]
pub struct Failover {
    pub to: Provider,
    pub reason: String,
}

/// Whether this goal should move to another account. Every guard is about
/// not moving: only from an idle, parked run, only when this account is spent
/// and the other is not, only onto an account that is set up, and at most
/// once an hour. A pinned goal moves only to get onto its pin.
#[allow(clippy::too_many_arguments)]
pub fn failover_decision(goal: &OdysseyRecord, journal_entries: &[JournalEntry], current: Provider, usage: &AccountUsage, candidates: &[Provider], parked: bool, idle: bool, now: i64) -> Option<Failover> {
    if goal.state != OdysseyState::Running && goal.state != OdysseyState::WaitingUsage {
        return None;
    }
    if !idle {
        return None;
    }
    if let Some(since) = journal::last_move_at(journal_entries)
        && now - since < FAILOVER_COOLDOWN_MS
    {
        return None;
    }
    let pinned = match goal.orchestrator {
        Orchestrator::Claude => Some(Provider::Claude),
        Orchestrator::Codex => Some(Provider::Codex),
        Orchestrator::Either => None,
    };
    if let Some(pin) = pinned {
        if pin == current {
            return None;
        }
        return Some(Failover { to: pin, reason: format!("this goal is set to run on {}", pin.label()) });
    }
    if !parked {
        return None;
    }
    let UsageVerdict::Exhausted { reason, .. } = usage_verdict(usage.get(&current)) else { return None };
    let other = candidates
        .iter()
        .copied()
        .filter(|provider| provider.can_orchestrate())
        .find(|provider| *provider != current && !usage_verdict(usage.get(provider)).is_exhausted())?;
    Some(Failover { to: other, reason: format!("{}'s account is spent ({reason}) and {}'s is not", current.label(), other.label()) })
}

/// A turn that says it is running but has produced no events at all for
/// `minutes`. `None` while it is alive, or when the limit is off.
pub fn dead_turn(running: bool, last_event_at: Option<i64>, now: i64, minutes: i64) -> Option<i64> {
    if !running || minutes <= 0 {
        return None;
    }
    let silent = now - last_event_at?;
    (silent >= minutes * 60_000).then_some(silent)
}

/// A duration the way a reader would say it.
pub fn stall_duration(ms: i64) -> String {
    let minutes = ms.max(0) / 60_000;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    if minutes % 60 == 0 { format!("{hours}h") } else { format!("{hours}h {}m", minutes % 60) }
}

/// The warning for a run that has been unable to act for the same reason
/// past the grace period.
pub fn stall_notice(reason: &str, since: Option<i64>, now: i64) -> Option<String> {
    let since = since?;
    if reason.is_empty() {
        return None;
    }
    let waited = now - since;
    (waited >= STALL_WARNING_MS).then(|| format!("Super Thing has not been able to act for {}: {reason}", stall_duration(waited)))
}

/// A goal set to stop after each milestone pauses instead of rolling on.
pub fn stops_after_milestone(goal: &OdysseyRecord) -> bool {
    matches!(goal.stop_condition, StopCondition::MilestoneComplete | StopCondition::Manual)
}

pub fn continuations_left(goal: &OdysseyRecord) -> i64 {
    (goal.max_continuations - goal.continuations_used).max(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::odyssey::JournalKind;
    use crate::superthing::journal::tests::entry;
    use crate::superthing::tests::{goal, milestone};
    use crate::superthing::usage::tests::{usage, window};

    const READY: SessionCondition = SessionCondition { attached: true, idle: true };

    fn briefed() -> Vec<JournalEntry> {
        vec![entry(JournalKind::Briefing, 1, "briefed", None)]
    }

    fn plan() -> Vec<MilestoneRecord> {
        vec![milestone("m1", MilestoneState::Verified), milestone("m2", MilestoneState::Active)]
    }

    fn run(goal: &OdysseyRecord, milestones: &[MilestoneRecord], journal: &[JournalEntry], session: SessionCondition, usage: Option<&UsageSnapshot>) -> Decision {
        decide(goal, milestones, journal, session, usage, 1_000_000, &Extra::default())
    }

    #[test]
    fn only_a_running_goal_acts() {
        for state in [OdysseyState::Draft, OdysseyState::Paused, OdysseyState::Blocked, OdysseyState::Complete, OdysseyState::Abandoned] {
            let mut goal = goal();
            goal.state = state;
            assert!(matches!(run(&goal, &plan(), &briefed(), READY, None), Decision::Idle { .. }));
        }
    }

    #[test]
    fn the_account_comes_before_the_session_and_the_budget_before_the_account() {
        let goal = goal();
        assert_eq!(run(&goal, &plan(), &briefed(), SessionCondition { attached: false, idle: true }, None), Decision::Idle { reason: "the session is not attached".into() });
        assert_eq!(run(&goal, &plan(), &briefed(), SessionCondition { attached: true, idle: false }, None), Decision::Idle { reason: "a turn is already running".into() });
        let spent = usage(Some(window(100.0, Some(1_700_000_000))), Some(window(40.0, None)));
        assert!(matches!(run(&goal, &plan(), &briefed(), SessionCondition { attached: true, idle: false }, Some(&spent)), Decision::WaitUsage { resume_at: Some(1_700_000_000_000), .. }));
        let mut capped = goal.clone();
        capped.continuations_used = 50;
        assert_eq!(run(&capped, &plan(), &briefed(), READY, Some(&spent)), Decision::Block { reason: "the continuation limit of 50 is used up".into() });
        let mut tokens = goal.clone();
        tokens.token_budget = Some(1_000);
        tokens.tokens_used = 1_000;
        assert_eq!(run(&tokens, &plan(), &briefed(), READY, None), Decision::Block { reason: "the token budget of 1,000 is used up".into() });
    }

    #[test]
    fn it_briefs_once_per_session_then_continues() {
        let goal = goal();
        assert_eq!(run(&goal, &plan(), &[], READY, None), Decision::Brief);
        assert_eq!(run(&goal, &plan(), &briefed(), READY, None), Decision::Continue { index: 1 });
        assert_eq!(run(&goal, &[], &briefed(), READY, None), Decision::Block { reason: "the goal has no milestones".into() });
    }

    #[test]
    fn it_waits_out_the_cooldown_after_a_prompt() {
        let goal = goal();
        let journal = vec![entry(JournalKind::Continuation, 1_000_000 - 1_000, "Continued", None), entry(JournalKind::Briefing, 1, "briefed", None)];
        assert_eq!(run(&goal, &plan(), &journal, READY, None), Decision::Idle { reason: "waiting out the cooldown after the last prompt".into() });
    }

    #[test]
    fn claims_completion_and_failure() {
        let goal = goal();
        let done = vec![milestone("m1", MilestoneState::Verified), milestone("m2", MilestoneState::Skipped)];
        assert_eq!(run(&goal, &done, &briefed(), READY, None), Decision::Complete);
        let claimed = vec![milestone("m1", MilestoneState::Verified), milestone("m2", MilestoneState::Reported)];
        assert_eq!(run(&goal, &claimed, &briefed(), READY, None), Decision::Complete, "a claim only a human could check is stepped over by default");
        let mut waiting = goal.clone();
        waiting.on_report = OnReport::Wait;
        assert_eq!(run(&waiting, &claimed, &briefed(), READY, None), Decision::AwaitVerification { index: 1 });
        let mut checkable = milestone("m1", MilestoneState::Reported);
        checkable.check_kind = CheckKind::TestsPass;
        checkable.check_spec = Some("pnpm test".into());
        assert_eq!(run(&goal, &[checkable, milestone("m2", MilestoneState::Planned)], &briefed(), READY, None), Decision::AwaitVerification { index: 0 });
        let failed = vec![milestone("m1", MilestoneState::Verified), milestone("m2", MilestoneState::Failed), milestone("m3", MilestoneState::Planned)];
        assert_eq!(run(&goal, &failed, &briefed(), READY, None), Decision::Continue { index: 1 });
    }

    #[test]
    fn a_run_that_changes_nothing_or_reaches_no_model_is_blocked() {
        let goal = goal();
        let mut stale: Vec<_> = (0..=STALE_TURN_LIMIT as i64).map(|index| entry(JournalKind::Checkpoint, 100 - index, "checkpoint", Some("same"))).collect();
        stale.extend(briefed());
        assert!(matches!(run(&goal, &plan(), &stale, READY, None), Decision::Block { reason } if reason.contains("changed nothing")));
        let mut rows = Vec::new();
        for index in 0..UNANSWERED_LIMIT as i64 {
            rows.push(entry(JournalKind::Guard, 100 - index * 2, journal::PROMPT_UNANSWERED, None));
            rows.push(entry(JournalKind::Continuation, 99 - index * 2, "Continued", None));
        }
        rows.extend(briefed());
        assert!(matches!(run(&goal, &plan(), &rows, READY, None), Decision::Block { reason } if reason.contains("never answered")));
    }

    #[test]
    fn runner_dispatched_work_keeps_the_orchestrator_quiet() {
        let extra = Extra { dispatched_open: vec!["2.1".into(), "2.2".into()] };
        assert_eq!(decide(&goal(), &plan(), &briefed(), READY, None, 1_000_000, &extra), Decision::Idle { reason: "workers are on tasks 2.1, 2.2".into() });
    }

    #[test]
    fn failover_moves_only_a_parked_idle_run_off_a_spent_account() {
        let mut goal = goal();
        goal.orchestrator = Orchestrator::Either;
        let spent = usage(Some(window(100.0, Some(10))), None);
        let roomy = usage(Some(window(10.0, None)), None);
        let mut accounts = AccountUsage::new();
        accounts.insert(Provider::Codex, spent.clone());
        accounts.insert(Provider::Claude, roomy);
        let all = [Provider::Claude, Provider::Codex, Provider::Gemini];
        let moved = failover_decision(&goal, &[], Provider::Codex, &accounts, &all, true, true, 0).unwrap();
        assert_eq!(moved.to, Provider::Claude);
        assert!(failover_decision(&goal, &[], Provider::Codex, &accounts, &all, true, false, 0).is_none(), "never mid-turn");
        assert!(failover_decision(&goal, &[], Provider::Codex, &accounts, &all, false, true, 0).is_none(), "never from a run that is not parked");
        accounts.insert(Provider::Claude, spent);
        assert!(failover_decision(&goal, &[], Provider::Codex, &accounts, &all, true, true, 0).is_none(), "both spent");
        let moved_row = entry(JournalKind::State, 0, "Moved to session s (claude)", None);
        accounts.remove(&Provider::Claude);
        assert!(failover_decision(&goal, std::slice::from_ref(&moved_row), Provider::Codex, &accounts, &all, true, true, FAILOVER_COOLDOWN_MS - 1).is_none(), "once an hour");
        assert!(failover_decision(&goal, &[moved_row], Provider::Codex, &accounts, &[Provider::Gemini], true, true, FAILOVER_COOLDOWN_MS).is_none(), "Gemini cannot lead");
        goal.orchestrator = Orchestrator::Claude;
        assert_eq!(failover_decision(&goal, &[], Provider::Codex, &AccountUsage::new(), &all, false, true, 0).unwrap().to, Provider::Claude, "a pinned goal moves onto its pin");
        assert!(failover_decision(&goal, &[], Provider::Claude, &accounts, &all, true, true, 0).is_none());
    }

    #[test]
    fn small_helpers() {
        assert_eq!(grouped(1_000), "1,000");
        assert_eq!(grouped(12_345_678), "12,345,678");
        assert_eq!(grouped(999), "999");
        assert_eq!(stall_duration(90 * 60_000), "1h 30m");
        assert_eq!(stall_duration(120 * 60_000), "2h");
        assert_eq!(stall_duration(5 * 60_000), "5m");
        assert!(stall_notice("waiting", Some(0), STALL_WARNING_MS - 1).is_none());
        assert_eq!(stall_notice("waiting", Some(0), STALL_WARNING_MS).unwrap(), "Super Thing has not been able to act for 5m: waiting");
        assert_eq!(dead_turn(true, Some(0), 30 * 60_000, 30), Some(30 * 60_000));
        assert_eq!(dead_turn(true, Some(0), 30 * 60_000 - 1, 30), None);
        assert_eq!(dead_turn(true, None, 30 * 60_000, 30), None);
        assert_eq!(dead_turn(true, Some(0), 99 * 60_000, 0), None);
        assert_eq!(dead_turn(false, Some(0), 99 * 60_000, 30), None);
    }
}
