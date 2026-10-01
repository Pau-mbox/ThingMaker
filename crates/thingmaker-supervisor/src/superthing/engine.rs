//! The engine: one service that runs every goal.
//!
//! A goal is worked by ticks. A tick reads the record, asks `decide` for the
//! one action to take, writes that decision to the journal and performs it —
//! a briefing, a continuation, a park on usage, a block, a check, a move to
//! another account. A turn settling is read back the same way: the claim, the
//! questions, the plan changes and the task moves go into the record before
//! the next tick looks at it. Every guard is derived from the record, so a
//! restart of the app, or of the interface, changes nothing about what the
//! run does next.
//!
//! One lock per goal serialises everything that touches it: the timer, a
//! settle, a tool call and the user's buttons. Nothing waits on a turn while
//! holding it.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use super::{
    apply, clock,
    decide::{self, Decision, Extra, SessionCondition},
    evidence::{self, Evidence},
    host::{EngineEvent, EngineHost, LiveSession, OpenSpec, RuntimeView},
    journal::{self, PLAN_REQUESTED, PROMPT_UNANSWERED, QUOTA_WAIT_HOLD, RUN_STARTED, TICK_FAILED, TRANSPORT_CLOSED},
    prompt::{self, BriefingOptions, ContinuationInput, Delta},
    protocol::{self, AMEND_INSTRUCTION, Amendment, ReportStatus, TurnProtocol},
    usage::{ResumeAction, UsageBook, UsageSnapshot, UsageVerdict, resume_decision, should_resample, usage_verdict},
    watch::{Signal, TurnRecord, Watch},
};
use crate::{
    DesktopError,
    agents::{
        Provider,
        events::{QuotaSnapshot, SubagentStatus},
    },
    delegation::{Combo, Delegation, JobView},
    odyssey_notes,
    storage::{
        Storage, StorageError,
        odyssey::{
            AmendmentState, CheckSource, Dispatch, GoalEdit, JournalEntry, JournalKind, MilestoneRecord, MilestoneState, NewAmendment, NewQuestion, NewUsageSample, OdysseyRecord, OdysseyState, OdysseyView,
            OnPlanChange, Orchestrator, PlanChangeState, QuestionState, StepState,
        },
    },
    supervisor::{SubmissionOutcome, TurnPhase},
};

/// How often every goal is looked at when nothing else wakes the engine.
pub const TICK_INTERVAL: Duration = Duration::from_secs(10);
/// Journal rows a decision reads. The guards only look back to the last
/// restart, so this is far more than they need.
const JOURNAL_DEPTH: usize = 200;
/// The least time between two attempts to reopen a goal's session.
const REOPEN_BACKOFF_MS: i64 = 2 * 60_000;
/// Deltas kept for the next continuation; older ones have been superseded.
const MAX_DELTAS: usize = 8;
const DELTAS_KEY: &str = "superthingDeltas";

pub fn goal_scope(goal_id: &str) -> String {
    format!("odyssey:{goal_id}")
}

/// Where the user wants a goal moved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MoveTarget {
    /// An open session, by its attachment handle.
    Session { handle: String },
    /// A fresh session on a provider.
    New { provider: Provider },
}

/// The turn the runner submitted and is waiting to settle.
#[derive(Debug, Clone)]
pub(crate) struct PendingTurn {
    pub handle: String,
    pub tokens_at_submit: Option<i64>,
    pub milestone: Option<usize>,
    /// The account's 5-hour reading at submit, for the turn's measured cost.
    pub window_at_submit: Option<(f64, Option<u64>)>,
    pub provider: Provider,
}

#[derive(Default)]
pub(crate) struct GoalState {
    pub pending: Option<PendingTurn>,
}

pub(crate) struct Inner {
    pub storage: Arc<Mutex<Storage>>,
    pub host: Arc<dyn EngineHost>,
    pub delegation: Option<Delegation>,
    pub data_dir: PathBuf,
    pub goals: Mutex<HashMap<String, Arc<tokio::sync::Mutex<GoalState>>>>,
    pub runtime: Mutex<HashMap<String, RuntimeView>>,
    pub watches: Mutex<HashMap<String, Arc<Watch>>>,
    /// Attachment handle → the goal running on it.
    pub session_goal: Mutex<HashMap<String, String>>,
    pub usage: Mutex<UsageBook>,
    /// What the agent sent through the tools during the current turn, by goal.
    pub inbox: Mutex<HashMap<String, TurnProtocol>>,
    pub signals: mpsc::UnboundedSender<Signal>,
    receiver: Mutex<Option<mpsc::UnboundedReceiver<Signal>>>,
    pub reopened: Mutex<HashMap<String, i64>>,
    /// Subagents and jobs already attributed, so a redraw does not rewrite.
    pub attributed: Mutex<HashMap<String, String>>,
}

/// The Super Thing service. Cloning shares it.
#[derive(Clone)]
pub struct Engine {
    pub(crate) inner: Arc<Inner>,
}

impl std::fmt::Debug for Engine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Engine").finish_non_exhaustive()
    }
}

/// A goal with everything a decision reads.
pub(crate) struct Loaded {
    pub goal: OdysseyRecord,
    pub milestones: Vec<MilestoneRecord>,
    pub journal: Vec<JournalEntry>,
}

impl Engine {
    pub fn new(storage: Arc<Mutex<Storage>>, host: Arc<dyn EngineHost>, delegation: Option<Delegation>, data_dir: PathBuf) -> Self {
        let (signals, receiver) = mpsc::unbounded_channel();
        Self {
            inner: Arc::new(Inner {
                storage,
                host,
                delegation,
                data_dir,
                goals: Mutex::new(HashMap::new()),
                runtime: Mutex::new(HashMap::new()),
                watches: Mutex::new(HashMap::new()),
                session_goal: Mutex::new(HashMap::new()),
                usage: Mutex::new(UsageBook::default()),
                inbox: Mutex::new(HashMap::new()),
                signals,
                receiver: Mutex::new(Some(receiver)),
                reopened: Mutex::new(HashMap::new()),
                attributed: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Starts the timer and the signal loop. Call once, inside the runtime.
    pub fn start(&self, interval: Duration) {
        let receiver = self.inner.receiver.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
        if let Some(mut receiver) = receiver {
            let engine = self.clone();
            tokio::spawn(async move {
                while let Some(signal) = receiver.recv().await {
                    let engine = engine.clone();
                    tokio::spawn(async move { engine.on_signal(signal).await });
                }
            });
        }
        let engine = self.clone();
        tokio::spawn(async move {
            let mut timer = tokio::time::interval(interval);
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                timer.tick().await;
                engine.poll().await;
            }
        });
    }

    // ------------------------------------------------------------ helpers

    pub(crate) fn db<T>(&self, f: impl FnOnce(&Storage) -> Result<T, StorageError>) -> Result<T, DesktopError> {
        let guard = self.inner.storage.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&guard).map_err(DesktopError::from)
    }

    pub(crate) fn load(&self, goal_id: &str) -> Result<Loaded, DesktopError> {
        self.db(|storage| {
            let view = storage.odyssey_view(goal_id)?.ok_or_else(|| StorageError::NotFound(format!("goal {goal_id} not found")))?;
            let journal = storage.odyssey_journal(goal_id, JOURNAL_DEPTH)?;
            Ok(Loaded { goal: view.goal, milestones: view.milestones, journal })
        })
    }

    pub fn view(&self, goal_id: &str) -> Result<Option<OdysseyView>, DesktopError> {
        self.db(|storage| storage.odyssey_view(goal_id))
    }

    pub(crate) fn journal(&self, goal_id: &str, kind: JournalKind, milestone_id: Option<&str>, summary: &str, detail: Option<&str>) {
        let _ = self.db(|storage| storage.odyssey_journal_append(goal_id, kind, milestone_id, None, summary, detail));
    }

    pub(crate) fn set_state(&self, goal_id: &str, state: OdysseyState) -> Result<(), DesktopError> {
        self.db(|storage| storage.odyssey_set_state(goal_id, state))
    }

    /// Tells the interface the record changed.
    pub(crate) fn changed(&self, goal_id: &str) {
        let Ok(Some(goal)) = self.db(|storage| storage.odyssey_get(goal_id)) else { return };
        let agent_session_id = goal.session_id.as_deref().and_then(|row| self.db(|storage| storage.session_get(row)).ok().flatten()).map(|row| row.agent_session_id);
        self.inner.host.emit(EngineEvent::Changed { goal_id: goal.id, workspace_id: goal.workspace_id, agent_session_id });
    }

    pub(crate) fn announce(&self, goal: &OdysseyRecord, text: &str) {
        self.inner.host.emit(EngineEvent::Announce { goal_id: goal.id.clone(), text: format!("{}: {text}", goal.title) });
    }

    pub(crate) fn notify(&self, goal: &OdysseyRecord, attention: &'static str, text: &str) {
        self.inner.host.emit(EngineEvent::Notify { goal_id: goal.id.clone(), workspace_id: goal.workspace_id.clone(), attention, text: format!("{}: {text}", goal.title) });
    }

    /// What the runner is doing for a goal.
    pub fn runtime(&self, goal_id: &str) -> RuntimeView {
        self.inner.runtime.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(goal_id).cloned().unwrap_or_default()
    }

    pub(crate) fn patch_runtime(&self, goal_id: &str, change: impl FnOnce(&mut RuntimeView)) {
        let view = {
            let mut map = self.inner.runtime.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let entry = map.entry(goal_id.to_string()).or_default();
            let before = entry.clone();
            change(entry);
            if *entry == before {
                return;
            }
            entry.clone()
        };
        self.inner.host.emit(EngineEvent::Runtime { goal_id: goal_id.to_string(), runtime: view });
    }

    /// Records a reason the runner stopped acting for, and resets the stall clock.
    pub(crate) fn note(&self, goal_id: &str, reason: &str, resume_at: Option<Option<i64>>) {
        let now = clock::now_ms();
        self.patch_runtime(goal_id, |runtime| {
            runtime.last_reason = reason.to_string();
            runtime.last_reason_at = now;
            runtime.ticking = false;
            runtime.stalled_since = None;
            runtime.stall_notified = false;
            if let Some(resume_at) = resume_at {
                runtime.resume_at = resume_at;
            }
        });
    }

    pub(crate) fn deltas(&self, goal_id: &str) -> Vec<Delta> {
        self.db(|storage| storage.setting_get::<Vec<Delta>>(DELTAS_KEY, &goal_scope(goal_id))).ok().flatten().unwrap_or_default()
    }

    pub(crate) fn set_deltas(&self, goal_id: &str, deltas: &[Delta]) {
        let _ = self.db(|storage| storage.setting_set(DELTAS_KEY, &goal_scope(goal_id), &deltas));
    }

    /// Queues a state change to tell the model in the next continuation.
    pub(crate) fn queue_delta(&self, goal_id: &str, delta: Delta) {
        let mut deltas = self.deltas(goal_id);
        deltas.push(delta);
        let start = deltas.len().saturating_sub(MAX_DELTAS);
        self.set_deltas(goal_id, &deltas[start..]);
    }

    fn goal_lock(&self, goal_id: &str) -> Arc<tokio::sync::Mutex<GoalState>> {
        self.inner.goals.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).entry(goal_id.to_string()).or_default().clone()
    }

    /// Ticks the goal soon, after whatever holds its lock lets go.
    pub fn nudge(&self, goal_id: &str) {
        let engine = self.clone();
        let goal_id = goal_id.to_string();
        tokio::spawn(async move { engine.tick(&goal_id, true).await });
    }

    // ------------------------------------------------------------ sessions

    /// The session a goal runs on, reopening it when the goal is running and
    /// nothing has it open: a run keeps going across an app restart.
    pub(crate) async fn live_for(&self, goal: &OdysseyRecord, reopen: bool) -> Option<LiveSession> {
        let row_id = goal.session_id.as_deref()?;
        if let Some(live) = self.inner.host.live(row_id) {
            self.adopt(goal, &live).await;
            return Some(live);
        }
        if !reopen {
            return None;
        }
        let now = clock::now_ms();
        {
            let mut reopened = self.inner.reopened.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if reopened.get(&goal.id).is_some_and(|at| now - at < REOPEN_BACKOFF_MS) {
                return None;
            }
            reopened.insert(goal.id.clone(), now);
        }
        let row = self.db(|storage| storage.session_get(row_id)).ok().flatten()?;
        let spec = OpenSpec { workspace_id: goal.workspace_id.clone(), provider: row.provider, combo: team_of(goal).map(|team| team.1), resume: Some(row.agent_session_id.clone()), ..OpenSpec::default() };
        match self.inner.host.open(spec).await {
            Ok(live) => {
                self.journal(&goal.id, JournalKind::State, None, "Reopened the run's session", Some(&format!("The session {} was not open, so Super Thing resumed it to carry on.", live.agent_session_id)));
                self.inner.host.emit(EngineEvent::SessionOpened { workspace_id: live.workspace_id.clone(), handle: live.handle.clone(), agent_session_id: live.agent_session_id.clone() });
                self.adopt(goal, &live).await;
                Some(live)
            }
            Err(error) => {
                self.note(&goal.id, &format!("the run's session could not be reopened: {}", error.message), None);
                None
            }
        }
    }

    /// Makes sure the session is watched, and remembered as this goal's.
    async fn adopt(&self, goal: &OdysseyRecord, live: &LiveSession) {
        self.inner.session_goal.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(live.handle.clone(), goal.id.clone());
        let known = self.inner.watches.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&live.handle).cloned();
        if known.is_none() {
            let watch = Watch::start(live.actor.clone(), live.provider, self.inner.signals.clone()).await;
            self.inner.watches.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(live.handle.clone(), watch);
        }
        self.patch_runtime(&goal.id, |runtime| runtime.session_handle = Some(live.handle.clone()));
    }

    pub(crate) fn watch(&self, handle: &str) -> Option<Arc<Watch>> {
        self.inner.watches.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(handle).cloned()
    }

    /// Paid input plus output for the session: the transcript's numbers, or
    /// the stream's for a provider without one the desktop reads.
    pub(crate) fn tokens(&self, live: &LiveSession) -> Option<i64> {
        self.inner.host.session_tokens(live).or_else(|| (live.provider == Provider::Gemini).then(|| self.watch(&live.handle).map(|watch| watch.state().stream_tokens)).flatten())
    }

    fn goal_for_handle(&self, handle: &str) -> Option<String> {
        self.inner.session_goal.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(handle).cloned()
    }

    // ------------------------------------------------------------ usage

    pub(crate) fn usage_for(&self, provider: Provider) -> Option<UsageSnapshot> {
        let mut book = self.inner.usage.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        book.refresh_claude_refusal(clock::now_ms());
        book.get(provider).cloned()
    }

    pub(crate) fn all_usage(&self) -> HashMap<Provider, UsageSnapshot> {
        let mut book = self.inner.usage.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        book.refresh_claude_refusal(clock::now_ms());
        book.all()
    }

    /// Asks the account again. A reading that cannot be taken leaves the
    /// last one in place.
    pub(crate) async fn refresh_usage(&self, provider: Provider) -> Option<UsageSnapshot> {
        if let Some(quota) = self.inner.host.quota(provider).await.filter(|quota| quota.provider == provider) {
            self.note_quota(&quota);
        }
        self.usage_for(provider)
    }

    /// After a failure that looked like a quota wall: Claude's refusal is
    /// itself the reading when it names one.
    pub(crate) async fn resample_account(&self, provider: Provider, message: Option<&str>) {
        if provider == Provider::Claude
            && let Some(message) = message
            && self.inner.usage.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).note_claude_limit(message, clock::now_ms())
        {
            return;
        }
        self.refresh_usage(provider).await;
    }

    /// A quota report from anywhere: the book, then one usage sample per goal
    /// running on that account.
    pub fn note_quota(&self, quota: &QuotaSnapshot) {
        let snapshot = self.inner.usage.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).note_quota(quota);
        if let Some(snapshot) = snapshot {
            self.record_samples(quota.provider, &snapshot);
        }
        if let Some(delegation) = &self.inner.delegation {
            delegation.note_quota(quota.clone());
        }
    }

    fn record_samples(&self, provider: Provider, snapshot: &UsageSnapshot) {
        let handles: Vec<(String, String)> = self.inner.session_goal.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).iter().map(|(handle, goal)| (handle.clone(), goal.clone())).collect();
        for (handle, goal_id) in handles {
            let Some(watch) = self.watch(&handle) else { continue };
            if watch.provider != provider {
                continue;
            }
            let Ok(Some(goal)) = self.db(|storage| storage.odyssey_get(&goal_id)) else { continue };
            if !matches!(goal.state, OdysseyState::Running | OdysseyState::WaitingUsage) {
                continue;
            }
            let Some(live) = goal.session_id.as_deref().and_then(|row| self.inner.host.live(row)) else { continue };
            let Some(tokens) = self.tokens(&live) else { continue };
            let sample = NewUsageSample {
                odyssey_id: goal_id.clone(),
                primary_used_percent: snapshot.primary.as_ref().map(|window| window.used_percent.round() as i64),
                primary_reset_at: snapshot.primary.as_ref().and_then(|window| window.reset_at_unix).map(|at| at as i64),
                secondary_used_percent: snapshot.secondary.as_ref().map(|window| window.used_percent.round() as i64),
                secondary_reset_at: snapshot.secondary.as_ref().and_then(|window| window.reset_at_unix).map(|at| at as i64),
                calls: 0,
                paid_input_tokens: tokens,
                cached_input_tokens: 0,
                output_tokens: 0,
                reasoning_tokens: 0,
            };
            let _ = self.db(|storage| storage.usage_sample_add(&sample));
        }
    }

    // ------------------------------------------------------------ the loop

    /// One pass over every goal the engine looks after.
    pub async fn poll(&self) {
        let Ok(goals) = self.db(|storage| storage.odyssey_active()) else { return };
        for goal in goals {
            match goal.state {
                OdysseyState::Running => self.tick(&goal.id, false).await,
                OdysseyState::WaitingUsage => self.poll_waiting(&goal.id).await,
                // A draft that asked for a plan needs its session watched for
                // the reply; any other goal keeps a watch only while it is open.
                _ => {
                    if self.inner.host.live(goal.session_id.as_deref().unwrap_or("")).is_some() {
                        let _ = self.live_for(&goal, false).await;
                    }
                }
            }
        }
    }

    /// One tick. `wait` decides whether to queue behind a tick already
    /// running (a user's button) or skip (the timer: nothing new to decide).
    pub async fn tick(&self, goal_id: &str, wait: bool) {
        let lock = self.goal_lock(goal_id);
        let mut state = if wait {
            lock.lock().await
        } else {
            match lock.try_lock() {
                Ok(state) => state,
                Err(_) => return,
            }
        };
        self.tick_locked(&mut state, goal_id).await;
    }

    pub(crate) async fn tick_locked(&self, state: &mut GoalState, goal_id: &str) {
        let Ok(loaded) = self.load(goal_id) else { return };
        let goal = loaded.goal.clone();
        if goal.state != OdysseyState::Running {
            return;
        }
        let now = clock::now_ms();
        let live = self.live_for(&goal, true).await;
        let provider = live.as_ref().map(|live| live.provider).or_else(|| goal.session_id.as_deref().and_then(|row| self.db(|storage| storage.session_get(row)).ok().flatten()).map(|row| row.provider)).unwrap_or_default();
        let watch = live.as_ref().and_then(|live| self.watch(&live.handle));
        let submitting = state.pending.as_ref().is_some_and(|pending| Some(&pending.handle) == live.as_ref().map(|live| &live.handle)) && watch.as_ref().is_some_and(|watch| !watch.state().foreground.is_active() && watch.state().turn.started_at.is_none());
        let condition = SessionCondition {
            attached: watch.as_ref().is_some_and(|watch| watch.attached()),
            idle: watch.as_ref().is_some_and(|watch| watch.idle()) && !submitting,
        };
        let usage = self.usage_for(provider);

        // Runner dispatch first: it may put workers on tasks, which is what
        // the decision then waits for.
        let extra = match &live {
            Some(live) if goal.dispatch == Dispatch::Runner && journal::briefed_this_session(&loaded.journal) => self.dispatch_ready(&loaded, live).await,
            _ => Extra::default(),
        };
        let loaded = if extra.dispatched_open.is_empty() { loaded } else { self.load(goal_id).unwrap_or(loaded) };

        let decision = decide::decide(&goal, &loaded.milestones, &loaded.journal, condition, usage.as_ref(), now, &extra);

        // The largest lever there is: a parked run on a spent account while
        // another subscription sits idle.
        let parked = matches!(decision, Decision::WaitUsage { .. }) || (matches!(decision, Decision::Idle { .. }) && journal::held_until(&loaded.journal).is_some_and(|hold| hold > now));
        let candidates = self.inner.host.usable_providers();
        if let Some(failover) = decide::failover_decision(&goal, &loaded.journal, provider, &self.all_usage(), &candidates, parked, condition.idle || !condition.attached, now) {
            let summary = format!("Moving to {}: {}", failover.to.label(), failover.reason);
            self.note(goal_id, &summary, None);
            self.announce(&goal, &summary);
            if let Err(error) = self.perform_move(state, goal_id, MoveTarget::New { provider: failover.to }, Some(summary)).await {
                self.note(goal_id, &format!("the move failed: {}", error.message), None);
            }
            return;
        }

        match decision {
            Decision::Idle { reason } => self.idle(&goal, &reason, live.as_ref(), watch.as_deref(), now).await,
            Decision::AwaitVerification { index } => {
                let milestone = &loaded.milestones[index];
                if decide::has_runnable_check(milestone) {
                    self.note(goal_id, &format!("running the check for milestone {}", index + 1), None);
                    self.run_check_locked(state, goal_id, &milestone.id).await;
                    return;
                }
                self.note(goal_id, &format!("milestone {} is reported complete and waiting for your tick", index + 1), None);
                let _ = self.set_state(goal_id, OdysseyState::Paused);
                self.journal(goal_id, JournalKind::State, None, &format!("Milestone {} reported complete; verify it to continue", index + 1), None);
                self.notify(&goal, "needs_input", &format!("milestone {} is reported complete; verify it to continue", index + 1));
                self.changed(goal_id);
            }
            Decision::Block { reason } => {
                let _ = self.set_state(goal_id, OdysseyState::Blocked);
                self.journal(goal_id, JournalKind::Guard, None, &reason, None);
                self.note(goal_id, &reason, None);
                self.notify(&goal, "blocked", &reason);
                self.changed(goal_id);
            }
            Decision::Complete => {
                let _ = self.set_state(goal_id, OdysseyState::Complete);
                let checked = loaded.milestones.iter().filter(|milestone| milestone.state == MilestoneState::Verified).count();
                let claimed = loaded.milestones.iter().filter(|milestone| milestone.state == MilestoneState::Reported).count();
                let summary = if claimed > 0 {
                    format!("Finished: {checked} of {} milestones were verified, {claimed} are the agent's word alone", loaded.milestones.len())
                } else {
                    "Every milestone is verified or skipped".to_string()
                };
                self.journal(goal_id, JournalKind::State, None, &summary, None);
                self.note(goal_id, "the goal is complete", Some(None));
                self.notify(&goal, "done", &summary);
                self.changed(goal_id);
            }
            Decision::WaitUsage { resume_at, reason } => self.park(&goal, &reason, resume_at, None),
            Decision::Brief | Decision::Continue { .. } => {
                let Some(live) = live else {
                    self.note(goal_id, "the session is not attached", None);
                    return;
                };
                // The forecast may move the run, or hold it until a reset,
                // before a turn that would not fit.
                if let Decision::Continue { index } = decision
                    && self.forecast_guard(state, &loaded, &live, index, now).await
                {
                    return;
                }
                self.submit(state, &loaded, &live, &decision).await;
            }
        }
    }

    /// Parks a goal on its account's usage window.
    pub(crate) fn park(&self, goal: &OdysseyRecord, reason: &str, resume_at: Option<i64>, extra: Option<&str>) {
        let _ = self.set_state(&goal.id, OdysseyState::WaitingUsage);
        let mut detail = resume_at.map(|at| format!("resume at {}", clock::iso8601(at))).unwrap_or_else(|| "the provider reported no reset time".into());
        if let Some(extra) = extra {
            detail.push('\n');
            detail.push_str(extra);
        }
        self.journal(&goal.id, JournalKind::Wait, None, &format!("Waiting for usage: {reason}"), Some(&detail));
        self.note(&goal.id, reason, Some(resume_at));
        self.changed(&goal.id);
    }

    /// Nothing to do; what is not news is the same reason holding for minutes.
    async fn idle(&self, goal: &OdysseyRecord, reason: &str, live: Option<&LiveSession>, watch: Option<&Watch>, now: i64) {
        let previous = self.runtime(&goal.id);
        let changed = previous.last_reason != reason;
        let since = if changed || previous.stalled_since.is_none() { now } else { previous.stalled_since.unwrap_or(now) };
        let notified = !changed && previous.stall_notified;
        self.patch_runtime(&goal.id, |runtime| {
            runtime.last_reason = reason.to_string();
            runtime.last_reason_at = now;
            runtime.ticking = false;
            runtime.stalled_since = Some(since);
            runtime.stall_notified = notified;
        });

        // A turn that produced nothing at all for a long time has stopped
        // being one. Jobs it delegated run in their workers' sessions, so open
        // jobs are its turn being alive.
        if let (Some(live), Some(watch)) = (live, watch) {
            let delegating = self.inner.delegation.as_ref().is_some_and(|delegation| delegation.jobs(&live.handle).iter().any(|job| !job.status.is_finished()));
            let snapshot = watch.snapshot();
            let working_agents = snapshot.agents.values().filter(|agent| matches!(agent.status, SubagentStatus::Working | SubagentStatus::Starting)).count();
            if reason == "a turn is already running"
                && let Some(silent) = decide::dead_turn(snapshot.foreground == TurnPhase::Running && !delegating, snapshot.last_event_at, now, goal.dead_turn_minutes)
            {
                let silent = decide::stall_duration(silent);
                let agents = if working_agents > 0 { format!(" while {working_agents} subagent{} still listed as working", if working_agents == 1 { " was" } else { "s were" }) } else { String::new() };
                let _ = live.actor.cancel().await;
                self.journal(
                    &goal.id,
                    JournalKind::Guard,
                    None,
                    &format!("Cancelled a turn that had produced nothing for {silent}{agents}"),
                    Some(&format!(
                        "No events at all reached the session in that time — not from the turn and not from any subagent — so nothing in it was alive and the turn could not settle on its own. The run continues from the last checkpoint{}.",
                        if working_agents > 0 { "; whatever those subagents wrote to docs/super-thing/agents/ is read by the next turn" } else { "" }
                    )),
                );
                self.announce(goal, &format!("cancelled a turn that went silent for {silent}"));
                self.note(&goal.id, &format!("cancelled a turn that went silent for {silent}"), None);
                self.changed(&goal.id);
                return;
            }
        }
        if let Some(notice) = decide::stall_notice(reason, Some(since), now)
            && !notified
        {
            self.patch_runtime(&goal.id, |runtime| runtime.stall_notified = true);
            self.journal(&goal.id, JournalKind::Guard, None, &notice, None);
            self.announce(goal, &notice);
            self.changed(&goal.id);
        }
    }

    /// A parked goal: re-sample when it is worth it, move to another account
    /// that has room, or resume when this one is back.
    async fn poll_waiting(&self, goal_id: &str) {
        let lock = self.goal_lock(goal_id);
        let Ok(mut state) = lock.try_lock() else { return };
        let Ok(loaded) = self.load(goal_id) else { return };
        let goal = loaded.goal.clone();
        if goal.state != OdysseyState::WaitingUsage {
            return;
        }
        let now = clock::now_ms();
        let live = self.live_for(&goal, false).await;
        let provider = live.as_ref().map(|live| live.provider).or_else(|| goal.session_id.as_deref().and_then(|row| self.db(|storage| storage.session_get(row)).ok().flatten()).map(|row| row.provider)).unwrap_or_default();
        let resume_at = self.runtime(goal_id).resume_at;
        if should_resample(self.usage_for(provider).as_ref(), resume_at, now) {
            self.refresh_usage(provider).await;
        }
        // Another account may have room while this one is still spent.
        let idle = live.as_ref().and_then(|live| self.watch(&live.handle)).is_none_or(|watch| watch.idle());
        let candidates = self.inner.host.usable_providers();
        for other in candidates.iter().copied().filter(|other| *other != provider && other.can_orchestrate()) {
            if should_resample(self.usage_for(other).as_ref(), None, now) {
                self.refresh_usage(other).await;
            }
        }
        if let Some(failover) = decide::failover_decision(&goal, &loaded.journal, provider, &self.all_usage(), &candidates, true, idle, now) {
            let summary = format!("Moving to {}: {}", failover.to.label(), failover.reason);
            self.announce(&goal, &summary);
            if let Err(error) = self.perform_move(&mut state, goal_id, MoveTarget::New { provider: failover.to }, Some(summary)).await {
                self.note(goal_id, &format!("the move failed: {}", error.message), None);
            }
            return;
        }
        let usage = self.usage_for(provider);
        let (action, reason) = resume_decision(&goal, usage.as_ref(), resume_at, now, provider == Provider::Claude);
        match action {
            ResumeAction::Hold => self.patch_runtime(goal_id, |runtime| {
                if let Some(at) = super::usage::waiting_until(usage.as_ref(), resume_at) {
                    runtime.resume_at = Some(at);
                }
            }),
            ResumeAction::Resume => {
                self.journal(goal_id, JournalKind::Resume, None, &reason, None);
                self.queue_delta(goal_id, Delta::Resumed { waited_ms: now - resume_at.unwrap_or(now), checkpoint_files: None });
                self.start_locked(&mut state, goal_id).await;
            }
            ResumeAction::Notify | ResumeAction::StayPaused => {
                let _ = self.set_state(goal_id, OdysseyState::Paused);
                self.journal(goal_id, JournalKind::Resume, None, &reason, None);
                if action == ResumeAction::Notify {
                    self.notify(&goal, "done", "usage reset, ready to resume");
                }
                self.note(goal_id, &reason, Some(None));
                self.changed(goal_id);
            }
        }
    }

    // ------------------------------------------------------------ prompts

    /// Checkpoints, builds the prompt and submits it. Every refusal is read
    /// for what it is: a busy session, a restart, a spent account, a fault.
    async fn submit(&self, state: &mut GoalState, loaded: &Loaded, live: &LiveSession, decision: &Decision) {
        let goal = &loaded.goal;
        self.patch_runtime(&goal.id, |runtime| {
            runtime.last_reason = "working".into();
            runtime.ticking = true;
            runtime.stalled_since = None;
            runtime.stall_notified = false;
        });
        let index = match decision {
            Decision::Continue { index } => Some(*index),
            _ => None,
        };
        let result = self.build_and_submit(state, loaded, live, index).await;
        if let Err(failure) = result {
            self.journal(
                &goal.id,
                JournalKind::Guard,
                None,
                &format!("{TICK_FAILED}: {}", failure.message),
                Some("The prompt was never sent, so nothing was charged to the budget. The run stops after a few of these rather than retrying a fault that does not clear by itself."),
            );
            self.note(&goal.id, &format!("the last tick failed: {}", failure.message), None);
            self.changed(&goal.id);
        }
    }

    pub(crate) fn tools_available(&self, live: &LiveSession) -> bool {
        live.provider.can_orchestrate() && self.inner.delegation.as_ref().is_some_and(|delegation| delegation.orchestrator_of(&live.handle).is_some())
    }

    fn team_combo(&self, live: &LiveSession) -> Option<Combo> {
        self.inner.delegation.as_ref().and_then(|delegation| delegation.combo(&live.handle))
    }

    /// The briefing a goal gets on a session, also shown before a run starts.
    pub(crate) fn briefing_for(&self, loaded: &Loaded, live: Option<&LiveSession>, skill_available: bool) -> String {
        let notes = live.and_then(|live| odyssey_notes::read_notes(&live.root).ok());
        let team = live.and_then(|live| self.team_combo(live));
        let memory_entries = self.db(|storage| storage.memory_count(&loaded.goal.workspace_id)).unwrap_or(0);
        prompt::build_briefing(
            &loaded.goal,
            &loaded.milestones,
            &BriefingOptions {
                skill_available,
                notes: notes.as_ref(),
                now: clock::now_ms(),
                handed_over: journal::handed_over(&loaded.journal),
                agent: live.map(|live| live.provider),
                team: team.as_ref(),
                tools: live.is_none_or(|live| self.tools_available(live)),
                runner_dispatch: loaded.goal.dispatch == Dispatch::Runner,
                memory_entries,
                branch: loaded.goal.branch.as_deref(),
            },
        )
    }

    async fn build_and_submit(&self, state: &mut GoalState, loaded: &Loaded, live: &LiveSession, index: Option<usize>) -> Result<(), DesktopError> {
        let goal = &loaded.goal;
        self.checkpoint(loaded, live, index.map(|index| loaded.milestones[index].id.as_str()))?;
        let brief = index.is_none();
        let skill_available = brief && self.inner.host.install_skill();
        if brief && live.provider == Provider::Claude {
            self.inner.host.install_delegate(&live.root);
        }
        let notes = odyssey_notes::read_notes(&live.root).ok();
        let carried = self.amendment_lines(goal)?;
        let tools = self.tools_available(live);
        let base = match index {
            None => self.briefing_for(loaded, Some(live), skill_available),
            Some(index) => {
                let mut deltas = self.deltas(&goal.id);
                let left = decide::continuations_left(goal);
                if left > 0 && left <= 3 {
                    deltas.push(Delta::Budget { continuations_left: left });
                }
                let agent_notes = prompt::agent_notes_since(notes.as_ref(), journal::last_prompt_at(&loaded.journal));
                prompt::build_continuation(&ContinuationInput {
                    milestone: &loaded.milestones[index],
                    index,
                    total: loaded.milestones.len(),
                    deltas: &deltas,
                    plan_path: goal.plan_path.as_deref(),
                    notes: Some(notes.as_ref()),
                    agent_notes: &agent_notes,
                    now: clock::now_ms(),
                    tools,
                })
            }
        };
        let text = if carried.lines.is_empty() {
            base
        } else {
            let mut lines = vec![base, String::new()];
            lines.extend(carried.lines.iter().cloned());
            if carried.changes {
                lines.push(String::new());
                lines.push(AMEND_INSTRUCTION.into());
            }
            lines.join("\n")
        };

        let tokens_at_submit = self.tokens(live);
        let window_at_submit = self.window_reading(live.provider).await;
        // What the tools say from here on belongs to this turn.
        self.inner.inbox.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&goal.id);
        state.pending = Some(PendingTurn { handle: live.handle.clone(), tokens_at_submit, milestone: index, window_at_submit, provider: live.provider });
        let outcome = live.actor.submit_text(format!("superthing-{}", uuid::Uuid::new_v4().simple()), &text).await;
        let refusal = match outcome {
            Ok(SubmissionOutcome::Accepted) => None,
            Ok(SubmissionOutcome::Rejected { error }) | Ok(SubmissionOutcome::OutcomeUnknown { error }) => Some(error.message),
            Err(error) => Some(error.message),
        };
        if let Some(message) = refusal {
            state.pending = None;
            self.refused(goal, live, &message).await;
            return Ok(());
        }

        let provider = Some(live.provider.as_str());
        let model = live.model.as_deref();
        match index {
            None => {
                let detail = serde_json::json!({ "startTokens": tokens_at_submit }).to_string();
                self.db(|storage| storage.odyssey_journal_append_by(&goal.id, JournalKind::Briefing, None, None, "Briefed the session on the goal", Some(&detail), provider, model))?;
            }
            Some(index) => {
                let milestone = &loaded.milestones[index];
                self.db(|storage| storage.milestone_set_state(&milestone.id, MilestoneState::Active))?;
                self.db(|storage| {
                    storage.odyssey_journal_append_by(&goal.id, JournalKind::Continuation, Some(&milestone.id), None, &format!("Continued milestone {} of {}", index + 1, loaded.milestones.len()), Some(&text), provider, model)
                })?;
                // Only a continuation carries deltas; a briefing does not
                // mention them, so they wait for the next continuation.
                self.set_deltas(&goal.id, &[]);
            }
        }
        for id in &carried.ids {
            let _ = self.db(|storage| storage.amendment_mark_told(id, goal.continuations_used));
        }
        self.note(&goal.id, &if brief { "briefed the session".to_string() } else { format!("working milestone {}", index.unwrap_or(0) + 1) }, None);
        self.changed(&goal.id);
        Ok(())
    }

    /// A prompt the session would not take.
    async fn refused(&self, goal: &OdysseyRecord, live: &LiveSession, message: &str) {
        let lower = message.to_lowercase();
        if lower.contains("already running a prompt") || lower.contains("session is busy") {
            self.note(&goal.id, "the session was busy; the next tick will try again", None);
            return;
        }
        if journal::looks_like_transport_error(Some(message)) {
            self.journal(&goal.id, JournalKind::Guard, None, &format!("{TRANSPORT_CLOSED}: {message}"), Some("The prompt was refused while the session was restarting. It is retried once the session is attached and idle again."));
            self.note(&goal.id, "the session was restarting; the next tick will try again", None);
            self.changed(&goal.id);
            return;
        }
        // A spent account is a wait, and on this side it can arrive as a
        // refused prompt rather than a failed turn.
        if journal::looks_like_quota_error(Some(message)) {
            self.resample_account(live.provider, Some(message)).await;
            let (resume_at, reason) = match usage_verdict(self.usage_for(live.provider).as_ref()) {
                UsageVerdict::Exhausted { resume_at, reason } => (resume_at, reason),
                UsageVerdict::Ok => (None, message.to_string()),
            };
            self.park(goal, &reason, resume_at, Some(&format!("The agent refused the prompt rather than failing the turn: {message}")));
            return;
        }
        let _ = self.set_state(&goal.id, OdysseyState::Blocked);
        self.journal(&goal.id, JournalKind::Guard, None, &format!("The session refused the prompt: {message}"), None);
        self.note(&goal.id, "the session refused the prompt", None);
        self.notify(goal, "blocked", &format!("the session refused the prompt: {message}"));
        self.changed(&goal.id);
    }

    /// The tree now against the tree at the previous checkpoint, journalled
    /// with the progress fingerprint the no-progress guard compares. In a run's
    /// own worktree it is also a commit.
    fn checkpoint(&self, loaded: &Loaded, live: &LiveSession, milestone_id: Option<&str>) -> Result<(), DesktopError> {
        let goal = &loaded.goal;
        let store = self.inner.data_dir.join("odyssey").join(&goal.id);
        let blobs = crate::review::BlobStore::new(self.inner.data_dir.join("blobs"));
        let Ok(checkpoint) = crate::odyssey_checkpoint::take_checkpoint(&live.root, &store, &blobs) else { return Ok(()) };
        let milestone_states: Vec<&str> = loaded.milestones.iter().map(|milestone| milestone.state.as_str()).collect();
        let step_states: Vec<&str> = loaded.milestones.iter().flat_map(|milestone| milestone.steps.iter().map(|step| step.state.as_str())).collect();
        let fingerprint = journal::progress_fingerprint(&checkpoint.tree_hash, &milestone_states, &step_states);
        let plural = |count: usize, noun: &str| format!("{count} {noun}{}", if count == 1 { "" } else { "s" });
        let mut summary = if checkpoint.first {
            format!("first checkpoint · {} in the tree", plural(checkpoint.file_count, "file"))
        } else if checkpoint.changed == 0 {
            "nothing changed since the last checkpoint".to_string()
        } else {
            format!("{} changed · +{} −{}{}", plural(checkpoint.changed, "file"), checkpoint.additions, checkpoint.deletions, if checkpoint.truncated { " · list cut" } else { "" })
        };
        if goal.worktree_path.is_some()
            && checkpoint.changed > 0
            && let Some(commit) = super::worktree::commit_checkpoint(&live.root, &format!("Super Thing checkpoint: {}", summary))
        {
            summary.push_str(&format!(" · commit {}", &commit[..commit.len().min(10)]));
        }
        let paths: Vec<String> = checkpoint.files.iter().map(|file| file.path.clone()).collect();
        let detail = journal::checkpoint_detail(&fingerprint, &paths);
        self.db(|storage| storage.odyssey_journal_append(&goal.id, JournalKind::Checkpoint, milestone_id, None, &summary, Some(&detail)))?;
        Ok(())
    }

    /// Queued amendments for the next prompt.
    fn amendment_lines(&self, goal: &OdysseyRecord) -> Result<Carried, DesktopError> {
        let records = self.db(|storage| storage.amendment_list(&goal.id))?;
        let mut carried = Carried::default();
        for record in records.iter().filter(|record| protocol::should_carry(record, goal.continuations_used)) {
            let document = if record.document_source.is_some() { self.db(|storage| storage.amendment_document(&record.id)).ok().flatten() } else { None };
            carried.lines.extend(protocol::describe_amendment(record, document.as_deref()));
            if record.tell_count > 0 && record.kind != "note" {
                carried.lines.push(protocol::retell_note(record));
            }
            if record.kind != "note" {
                carried.changes = true;
            }
            carried.ids.push(record.id.clone());
        }
        Ok(carried)
    }

    // ------------------------------------------------------------ signals

    async fn on_signal(&self, signal: Signal) {
        match signal {
            Signal::Settled { handle, phase, error, turn } => {
                let Some(goal_id) = self.goal_for_handle(&handle) else { return };
                let lock = self.goal_lock(&goal_id);
                let mut state = lock.lock().await;
                self.on_settle_locked(&mut state, &goal_id, &handle, phase, error, turn).await;
                drop(state);
                self.tick(&goal_id, true).await;
            }
            Signal::AgentsChanged { handle } => {
                if let Some(goal_id) = self.goal_for_handle(&handle) {
                    self.observe_agents(&goal_id, &handle);
                }
            }
            Signal::Permission { handle, title, decision } => {
                // Every decision taken on an unattended run goes in the record.
                if let Some(goal_id) = self.goal_for_handle(&handle) {
                    let decision = if decision == "allowed" { "allowed" } else { "refused" };
                    self.journal(
                        &goal_id,
                        JournalKind::Guard,
                        None,
                        &format!("Permission {decision}: {}", title.as_deref().unwrap_or("an unnamed request")),
                        Some(&format!("The agent asked to do something its permission mode did not already cover, and the run answered {decision} from the workspace's trust state. Nobody was asked.")),
                    );
                }
            }
            Signal::Quota(quota) => self.note_quota(&quota),
            Signal::Exited { handle } => {
                self.inner.watches.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&handle);
                if let Some(goal_id) = self.goal_for_handle(&handle) {
                    self.inner.session_goal.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&handle);
                    self.nudge(&goal_id);
                }
            }
        }
    }

    /// After a turn settles: record what happened, then the caller ticks.
    pub(crate) async fn on_settle_locked(&self, state: &mut GoalState, goal_id: &str, handle: &str, phase: TurnPhase, error: Option<String>, turn: TurnRecord) {
        let Ok(loaded) = self.load(goal_id) else { return };
        let goal = loaded.goal.clone();
        let tools = self.inner.inbox.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(goal_id).unwrap_or_default();
        let protocol = TurnProtocol::read(&turn.text(), tools);

        // A draft that asked for a plan is waiting for this turn's reply.
        if goal.state == OdysseyState::Draft {
            let asked = loaded.journal.iter().find(|entry| entry.kind == JournalKind::Plan).is_some_and(|entry| entry.summary == PLAN_REQUESTED);
            state.pending = None;
            if phase == TurnPhase::Succeeded && asked && loaded.milestones.is_empty() {
                self.read_plan(&goal, protocol.plan);
            }
            return;
        }
        if !matches!(goal.state, OdysseyState::Running | OdysseyState::WaitingUsage) {
            return;
        }
        let Some(live) = goal.session_id.as_deref().and_then(|row| self.inner.host.live(row)).filter(|live| live.handle == handle) else { return };
        let pending = state.pending.take().filter(|pending| pending.handle == handle);

        // Did a model answer at all? A settle is not proof of a turn.
        let total = self.tokens(&live);
        let answered = match &pending {
            None => true,
            Some(pending) => match (total, pending.tokens_at_submit) {
                (Some(total), Some(before)) => total > before || turn.produced(),
                _ => turn.produced(),
            },
        };
        let error_text = error.as_deref();
        if !answered {
            self.journal(
                goal_id,
                JournalKind::Guard,
                None,
                PROMPT_UNANSWERED,
                Some(&format!(
                    "The turn {}{}. It is not charged to the budget and its checkpoint is not evidence of a stale turn.",
                    phase_word(phase),
                    error_text.map(|error| format!(": {error}")).unwrap_or_else(|| " with no model output".into())
                )),
            );
            if journal::looks_like_quota_error(error_text) {
                self.resample_account(live.provider, error_text).await;
            }
            self.changed(goal_id);
            return;
        }

        // Charge the turn to the budget from the provider's own numbers.
        let start = journal::start_tokens(&loaded.journal);
        let charge = match (total, start) {
            (Some(total), Some(start)) => ((total - start).max(0) - goal.tokens_used).max(0),
            _ => 0,
        };
        let _ = self.db(|storage| storage.odyssey_record_continuation(goal_id, charge));
        if let Some(pending) = &pending {
            self.measure_turn(goal_id, pending).await;
        }

        if phase != TurnPhase::Succeeded {
            if journal::looks_like_quota_error(error_text) {
                self.resample_account(live.provider, error_text).await;
                self.changed(goal_id);
                return;
            }
            if journal::looks_like_transport_error(error_text) {
                self.journal(
                    goal_id,
                    JournalKind::Guard,
                    None,
                    &format!("{TRANSPORT_CLOSED}: {}", error_text.unwrap_or("")),
                    Some("The session's process or channel ended under the turn. That is not the agent's failure; the run continues from the last checkpoint once the session is attached again, and reads docs/super-thing/agents/ for anything a subagent finished before it died."),
                );
                self.changed(goal_id);
                return;
            }
            let _ = self.set_state(goal_id, OdysseyState::Blocked);
            let summary = format!("The turn {}{}", phase_word(phase), error_text.map(|error| format!(": {error}")).unwrap_or_default());
            self.journal(goal_id, JournalKind::Guard, None, &summary, None);
            self.notify(&goal, "blocked", &summary);
            self.changed(goal_id);
            return;
        }

        // An answered Claude turn: the account is read again.
        if live.provider == Provider::Claude {
            let engine = self.clone();
            tokio::spawn(async move {
                if engine.refresh_usage(Provider::Claude).await.is_none() {
                    engine.inner.usage.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clear(Provider::Claude);
                }
            });
        }

        // Plan changes first, so a milestone the change added is in the list
        // before anything claims to have finished one.
        if let Some(amendment) = protocol.amendment.clone() {
            self.apply_amendment(&goal, amendment);
        }
        let loaded = self.load(goal_id).unwrap_or(loaded);
        self.read_report(&loaded, &live, &turn, protocol.report.clone()).await;
        self.read_asks(&loaded, &protocol.asks);
        self.read_tasks(&loaded, &live, &protocol.tasks);
        self.changed(goal_id);
    }

    async fn read_report(&self, loaded: &Loaded, live: &LiveSession, turn: &TurnRecord, report: Option<protocol::Report>) {
        let goal = &loaded.goal;
        let Some(report) = report else { return };
        let Some(milestone) = loaded.milestones.get(report.milestone - 1) else { return };
        if journal::already_reported(&loaded.journal, &milestone.id, &report.note) {
            return;
        }
        match report.status {
            ReportStatus::Complete => {
                let _ = self.db(|storage| storage.milestone_record_report(&milestone.id, &report.note));
                self.journal(&goal.id, JournalKind::Report, Some(&milestone.id), &format!("Reported milestone {} complete", report.milestone), Some(&report.note));
                if !evidence::readable_from_tool_results(milestone.check_kind) {
                    return;
                }
                // The exit code in the turn's own tool record decides; the
                // prose never does.
                let calls = live.actor.snapshot().await.map(|snapshot| snapshot.tool_calls).unwrap_or_default();
                let results: Vec<_> = turn.tool_ids.iter().filter_map(|id| calls.get(id)).flat_map(|patch| evidence::shell_results_of(patch, live.provider)).collect();
                match evidence::evidence_for(milestone.check_spec.as_deref(), &results) {
                    Evidence::Found { result, how } => {
                        let passed = result.exit_code == 0;
                        let tail = evidence::failure_tail(&result);
                        let output = format!("{how} (check run by the agent, exit code read from its tool result){}", if tail.is_empty() { String::new() } else { format!("\n\n{tail}") });
                        let _ = self.db(|storage| storage.milestone_record_check(&milestone.id, passed, &output, CheckSource::AgentToolResult));
                        self.journal(&goal.id, JournalKind::Check, Some(&milestone.id), &format!("The agent's own check for milestone {} {}", report.milestone, if passed { "passed" } else { "failed" }), Some(&how));
                        self.queue_delta(
                            &goal.id,
                            if passed {
                                Delta::Verified { milestone: report.milestone, title: milestone.title.clone(), evidence: how }
                            } else {
                                Delta::CheckFailed {
                                    milestone: report.milestone,
                                    title: milestone.title.clone(),
                                    command: result.command.clone().or_else(|| milestone.check_spec.clone()).unwrap_or_else(|| "the check".into()),
                                    exit_code: result.exit_code,
                                    tail,
                                }
                            },
                        );
                    }
                    Evidence::Absent { reason } | Evidence::Ambiguous { reason } => {
                        self.journal(&goal.id, JournalKind::Check, Some(&milestone.id), &format!("Nothing in the turn's tool results verified milestone {}", report.milestone), Some(&reason));
                    }
                }
            }
            ReportStatus::Blocked if journal::looks_like_quota_wait(Some(&report.note)) => {
                // A wait, not a block: the run holds its next prompt until
                // the time the note names.
                let until = journal::quota_wait_until(&report.note, clock::now_ms());
                self.journal(
                    &goal.id,
                    JournalKind::Guard,
                    Some(&milestone.id),
                    &format!("{QUOTA_WAIT_HOLD}: {}", report.note),
                    Some(&format!("until={until}\nReported as blocked, read as a wait: the run continues and the next continuation goes out at {}.", clock::local_hhmm(until))),
                );
                self.announce(goal, &format!("the agent is waiting on a quota; Super Thing resumes it at {}", clock::local_hhmm(until)));
            }
            ReportStatus::Blocked => {
                let _ = self.db(|storage| storage.milestone_set_state(&milestone.id, MilestoneState::Failed));
                self.journal(&goal.id, JournalKind::Report, Some(&milestone.id), &format!("Reported milestone {} blocked", report.milestone), Some(&report.note));
                let _ = self.set_state(&goal.id, OdysseyState::Blocked);
                self.notify(goal, "blocked", &format!("the agent reported milestone {} blocked: {}", report.milestone, report.note));
            }
        }
    }

    fn read_asks(&self, loaded: &Loaded, asks: &[protocol::Ask]) {
        let goal = &loaded.goal;
        let open: Vec<String> = self.db(|storage| storage.question_list(&goal.id, 100)).unwrap_or_default().into_iter().filter(|question| question.state == QuestionState::Open).map(|question| question.question).collect();
        let mut asked = 0;
        for ask in asks {
            if open.contains(&ask.question) {
                continue;
            }
            let new = NewQuestion { odyssey_id: goal.id.clone(), kind: ask.kind.clone(), question: ask.question.clone(), options: ask.options.clone(), fallback: Some(ask.fallback.clone()).filter(|fallback| !fallback.is_empty()) };
            let _ = self.db(|storage| storage.question_add(&new));
            self.journal(&goal.id, JournalKind::Plan, None, &format!("The agent asked you: {}", ask.question), (!ask.fallback.is_empty()).then(|| format!("Meanwhile: {}", ask.fallback)).as_deref());
            asked += 1;
        }
        if asked > 0 {
            self.announce(goal, "the agent has a question for you");
            self.notify(goal, "needs_input", "the agent has a question for you");
        }
    }

    fn read_tasks(&self, loaded: &Loaded, live: &LiveSession, lines: &[protocol::TaskLine]) {
        let agents = self.watch(&live.handle).map(|watch| watch.state().agents.clone()).unwrap_or_default();
        for line in lines {
            let Some(step) = loaded.milestones.get(line.milestone - 1).and_then(|milestone| milestone.steps.get(line.task - 1)) else { continue };
            let _ = self.db(|storage| storage.step_set_state(&step.id, line.status.step_state(), Some(&line.note).filter(|note| !note.is_empty()).map(String::as_str)));
            if let Some(agent) = &line.agent {
                let seen = agents.values().find(|seen| seen.name == *agent);
                let _ = self.db(|storage| storage.step_assign(&step.id, Some(agent), seen.map(|seen| seen.harness.as_str()), seen.and_then(|seen| seen.model.as_deref())));
            }
        }
    }

    /// Reads a proposed plan into a draft. The goal stays a draft: a plan out
    /// of a document has not been approved by anyone yet.
    fn read_plan(&self, goal: &OdysseyRecord, plan: Option<protocol::ProposedPlan>) {
        let Some(plan) = plan else {
            self.journal(&goal.id, JournalKind::Plan, None, "The agent proposed no plan", Some("Its reply contained no plan. Read what it said, then ask again or write the milestones yourself."));
            self.changed(&goal.id);
            return;
        };
        match self.db(|storage| apply::write_plan(storage, &goal.id, &plan)) {
            Ok(count) => {
                self.journal(
                    &goal.id,
                    JournalKind::Plan,
                    None,
                    &format!("The agent proposed {count} milestone{} from {}", if count == 1 { "" } else { "s" }, goal.plan_source.as_deref().unwrap_or("the document")),
                    Some(&plan.notes.join(" ")).filter(|notes| !notes.is_empty()).map(String::as_str),
                );
                self.announce(goal, &format!("the agent proposed {count} milestones — review them and start the run"));
                self.notify(goal, "needs_input", "the plan is ready for you to review");
            }
            Err(error) => self.journal(&goal.id, JournalKind::Plan, None, "The proposed plan could not be written", Some(&error.message)),
        }
        self.note(&goal.id, "waiting for you to review the plan", None);
        self.changed(&goal.id);
    }

    /// Applies an amendment: under the default, task housekeeping lands at
    /// once and changes to what a milestone is wait for the user.
    pub(crate) fn apply_amendment(&self, goal: &OdysseyRecord, amendment: Amendment) {
        let Ok(loaded) = self.load(&goal.id) else { return };
        let reason = amendment.ops.iter().map(|op| op.reason()).find(|reason| !reason.is_empty()).map(str::to_string);
        let (held, auto): (Vec<_>, Vec<_>) = match goal.on_plan_change {
            OnPlanChange::Auto => (Vec::new(), amendment.ops.clone()),
            OnPlanChange::Review => (amendment.ops.clone(), Vec::new()),
            OnPlanChange::TasksAuto => amendment.ops.iter().cloned().partition(|op| op.is_milestone_scope()),
        };
        if !auto.is_empty() {
            let resolved = protocol::resolve_ops(&auto, &loaded.milestones);
            let summary = protocol::diff_text(&protocol::plan_diff(&resolved, &loaded.milestones));
            let ops = serde_json::to_string(&auto).unwrap_or_default();
            let _ = self.db(|storage| storage.plan_change_add(&goal.id, &ops, &summary, reason.as_deref(), PlanChangeState::Applied));
            self.apply_resolved(goal, &loaded.milestones, &resolved, if held.is_empty() { &amendment.notes } else { &[] });
        }
        if held.is_empty() {
            return;
        }
        let milestones = self.load(&goal.id).map(|loaded| loaded.milestones).unwrap_or(loaded.milestones);
        let resolved = protocol::resolve_ops(&held, &milestones);
        let summary = protocol::diff_text(&protocol::plan_diff(&resolved, &milestones));
        // One decision, not three: the newest proposal stands.
        for prior in self.db(|storage| storage.plan_change_list(&goal.id, 50)).unwrap_or_default().into_iter().filter(|change| change.state == PlanChangeState::Proposed) {
            let _ = self.db(|storage| storage.plan_change_decide(&prior.id, PlanChangeState::Rejected, Some("superseded by a newer proposal from the agent")));
        }
        let ops = serde_json::to_string(&amendment.ops).unwrap_or_default();
        let _ = self.db(|storage| storage.plan_change_add(&goal.id, &ops, &summary, reason.as_deref(), PlanChangeState::Proposed));
        let mut detail = vec![summary.clone()];
        detail.extend(amendment.notes.iter().cloned());
        self.journal(&goal.id, JournalKind::Plan, None, &format!("The agent proposed a plan change: {} operation{}, waiting for you", resolved.len(), if resolved.len() == 1 { "" } else { "s" }), Some(&detail.join("\n")));
        let short: Vec<&str> = summary.split('\n').take(3).collect();
        self.queue_delta(&goal.id, Delta::PlanChangePending { summary: format!("{}{}", short.join("; "), if resolved.len() > 3 { "; …" } else { "" }) });
        self.announce(goal, "the agent proposed a plan change — review it in the Inbox");
        self.notify(goal, "needs_input", "the agent proposed a plan change");
    }

    fn apply_resolved(&self, goal: &OdysseyRecord, milestones: &[MilestoneRecord], resolved: &[protocol::ResolvedOp], notes: &[String]) {
        let told: Vec<String> = self.db(|storage| storage.amendment_list(&goal.id)).unwrap_or_default().into_iter().filter(|record| record.state == AmendmentState::Told).map(|record| record.id).collect();
        match self.db(|storage| apply::apply_ops(storage, &goal.id, milestones, resolved)) {
            Ok(applied) => {
                let mut detail = applied.clone();
                detail.extend(notes.iter().cloned());
                self.journal(&goal.id, JournalKind::Plan, None, &format!("The plan changed: {} operation{}", applied.len(), if applied.len() == 1 { "" } else { "s" }), Some(&detail.join("\n")));
                for id in told {
                    let _ = self.db(|storage| storage.amendment_set_state(&id, AmendmentState::Applied));
                }
                self.queue_delta(&goal.id, Delta::PlanEdited { summary: applied.join("; ") });
            }
            Err(error) => self.journal(&goal.id, JournalKind::Plan, None, "The plan change could not be applied", Some(&error.message)),
        }
    }

    /// Ties subagents the stream reported to the tasks they are named after.
    fn observe_agents(&self, goal_id: &str, handle: &str) {
        let Some(watch) = self.watch(handle) else { return };
        let Ok(loaded) = self.load(goal_id) else { return };
        let agents = watch.state().agents.clone();
        let mut changed = false;
        for (id, agent) in agents {
            let key = format!("{:?}|{}|{}", agent.status, agent.harness, agent.model.as_deref().unwrap_or(""));
            let seen_key = format!("{handle}/{id}");
            if self.inner.attributed.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&seen_key) == Some(&key) {
                continue;
            }
            let Some((milestone_index, step_index)) = protocol::match_agent_to_task(&agent.name, &loaded.milestones) else { continue };
            self.inner.attributed.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(seen_key, key);
            let step = &loaded.milestones[milestone_index].steps[step_index];
            if step.agent_name.as_deref() != Some(agent.name.as_str()) || step.harness.as_deref() != Some(agent.harness.as_str()) || (agent.model.is_some() && step.model != agent.model) {
                let _ = self.db(|storage| storage.step_assign(&step.id, Some(&agent.name), Some(&agent.harness), agent.model.as_deref()));
                changed = true;
            }
            if matches!(agent.status, SubagentStatus::Working | SubagentStatus::Starting) && step.state == StepState::Pending {
                let _ = self.db(|storage| storage.step_set_state(&step.id, StepState::InProgress, None));
                changed = true;
            }
        }
        if changed {
            self.changed(goal_id);
        }
    }

    /// A job changed. Runner-dispatched tasks move with their jobs; a job the
    /// orchestrator named after a task is that task's worker.
    pub fn note_job(&self, job: &JobView) {
        let Some(goal_id) = self.goal_for_handle(&job.orchestrator) else { return };
        let engine = self.clone();
        let job = job.clone();
        tokio::spawn(async move { engine.job_changed(&goal_id, &job).await });
    }

    // ------------------------------------------------------------ commands

    /// Starts or resumes a run. Pressing Resume is the user saying "try it
    /// now": the account is read again first.
    pub async fn start_goal(&self, goal_id: &str) -> Result<(), DesktopError> {
        let lock = self.goal_lock(goal_id);
        let mut state = lock.lock().await;
        let loaded = self.load(goal_id)?;
        // A run with its own worktree gets it before anything is sent.
        if loaded.goal.state == OdysseyState::Draft && loaded.goal.isolate && loaded.goal.worktree_path.is_none() {
            self.isolate(&mut state, &loaded).await?;
        }
        let loaded = self.load(goal_id)?;
        if let Some(live) = self.live_for(&loaded.goal, true).await
            && live.provider == Provider::Claude
            && self.refresh_usage(Provider::Claude).await.is_none()
        {
            self.inner.usage.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clear(Provider::Claude);
        }
        self.start_locked(&mut state, goal_id).await;
        Ok(())
    }

    pub(crate) async fn start_locked(&self, state: &mut GoalState, goal_id: &str) {
        if self.start_record(goal_id) {
            self.tick_locked(state, goal_id).await;
        }
    }

    /// Marks a goal running, with the exact words the guards look for, so a
    /// restart clears them. The caller ticks.
    pub(crate) fn start_record(&self, goal_id: &str) -> bool {
        let Ok(goal) = self.load(goal_id).map(|loaded| loaded.goal) else { return false };
        let summary = if goal.state == OdysseyState::Draft { RUN_STARTED.to_string() } else { journal::resumed_from(goal.state.as_str()) };
        if self.set_state(goal_id, OdysseyState::Running).is_err() {
            return false;
        }
        self.journal(goal_id, JournalKind::State, None, &summary, None);
        self.changed(goal_id);
        true
    }

    /// Pauses before the next continuation; an in-flight turn is left alone.
    pub async fn pause(&self, goal_id: &str, reason: Option<&str>) -> Result<(), DesktopError> {
        let lock = self.goal_lock(goal_id);
        let _state = lock.lock().await;
        self.set_state(goal_id, OdysseyState::Paused)?;
        self.journal(goal_id, JournalKind::State, None, reason.unwrap_or("Paused by you"), None);
        self.note(goal_id, "paused", Some(None));
        self.changed(goal_id);
        Ok(())
    }

    /// The user's "Move to…".
    pub async fn move_goal(&self, goal_id: &str, target: MoveTarget) -> Result<(), DesktopError> {
        let lock = self.goal_lock(goal_id);
        let mut state = lock.lock().await;
        self.perform_move(&mut state, goal_id, target, None).await
    }

    /// Moves a goal onto another session and leaves it running there. Shared
    /// by the user's move and by failover; `reason`, when given, is why the
    /// run changed accounts on its own.
    pub(crate) async fn perform_move(&self, state: &mut GoalState, goal_id: &str, target: MoveTarget, reason: Option<String>) -> Result<(), DesktopError> {
        let loaded = self.load(goal_id)?;
        let goal = loaded.goal.clone();
        let current = self.live_for(&goal, false).await;
        // A turn owns the working tree: it is cancelled before anything moves,
        // so two orchestrators never edit it at once.
        if let Some(current) = &current
            && self.watch(&current.handle).is_some_and(|watch| !watch.idle())
        {
            let _ = current.actor.cancel().await;
        }
        let combo = team_of(&goal).map(|team| team.1).or_else(|| current.as_ref().and_then(|current| self.team_combo(current)));
        let target_live = match target {
            MoveTarget::Session { handle } => self.inner.host.live_handle(&handle).ok_or_else(|| DesktopError::not_ready("that session is not attached any more"))?,
            MoveTarget::New { provider } => {
                if !provider.can_orchestrate() && reason.is_some() {
                    return Err(DesktopError::unsupported(format!("{} cannot lead a run", provider.label())));
                }
                // Moving onto an account that cannot answer at all is how a
                // goal ends up on a session that never takes a prompt.
                if provider == Provider::Claude
                    && let Some(quota) = self.inner.host.quota(Provider::Claude).await
                    && quota.status == crate::agents::events::QuotaStatus::Rejected
                {
                    return Err(DesktopError::not_ready("the Claude account has no room right now"));
                }
                let (model, effort) = team_of(&goal).filter(|team| team.0.provider == Some(provider)).map(|team| (team.0.model, team.0.effort)).unwrap_or_default();
                let live = self.inner.host.open(OpenSpec { workspace_id: goal.workspace_id.clone(), provider, model, effort, combo, resume: None }).await?;
                self.inner.host.emit(EngineEvent::SessionOpened { workspace_id: live.workspace_id.clone(), handle: live.handle.clone(), agent_session_id: live.agent_session_id.clone() });
                live
            }
        };
        let row = self.db(|storage| storage.odyssey_session_row(&goal.workspace_id, &target_live.agent_session_id, Some(target_live.provider)))?.ok_or_else(|| DesktopError::not_ready("that session has no desktop record"))?;
        self.db(|storage| storage.odyssey_repoint(goal_id, &row))?;
        match &reason {
            Some(reason) => self.journal(goal_id, JournalKind::State, None, reason, None),
            None => {
                // A move by hand is a statement about which account the run
                // spends; a goal set to `either` is left alone.
                let landed = match target_live.provider {
                    Provider::Codex => Orchestrator::Codex,
                    Provider::Claude => Orchestrator::Claude,
                    Provider::Gemini => Orchestrator::Either,
                };
                if goal.orchestrator != Orchestrator::Either && goal.orchestrator != landed {
                    let _ = self.db(|storage| storage.odyssey_edit_goal(goal_id, &GoalEdit { orchestrator: Some(landed), ..GoalEdit::default() }));
                }
            }
        }
        state.pending = None;
        if let Some(current) = &current {
            self.inner.session_goal.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&current.handle);
        }
        self.adopt(&goal, &target_live).await;
        self.inner.host.emit(EngineEvent::Moved {
            goal_id: goal_id.to_string(),
            from_agent_session_id: current.map(|current| current.agent_session_id),
            to_agent_session_id: target_live.agent_session_id.clone(),
            to_handle: target_live.handle.clone(),
        });
        self.changed(goal_id);
        // A goal parked on usage runs again the moment it is on an account
        // with room.
        if goal.state == OdysseyState::WaitingUsage {
            let _ = self.set_state(goal_id, OdysseyState::Running);
            self.journal(goal_id, JournalKind::State, None, &journal::resumed_from("waiting_usage"), None);
        }
        self.nudge(goal_id);
        Ok(())
    }

    /// The user ticking a manual milestone: the user is the evidence.
    pub async fn verify(&self, goal_id: &str, milestone_id: &str) -> Result<(), DesktopError> {
        let lock = self.goal_lock(goal_id);
        let mut state = lock.lock().await;
        let loaded = self.load(goal_id)?;
        let index = loaded.milestones.iter().position(|milestone| milestone.id == milestone_id).ok_or_else(|| DesktopError::not_ready("milestone not found"))?;
        self.db(|storage| storage.milestone_record_check(milestone_id, true, "ticked by you", CheckSource::User))?;
        self.journal(goal_id, JournalKind::Check, Some(milestone_id), &format!("You verified milestone {}", index + 1), None);
        self.queue_delta(goal_id, Delta::Verified { milestone: index + 1, title: loaded.milestones[index].title.clone(), evidence: "you ticked it".into() });
        self.changed(goal_id);
        if !decide::stops_after_milestone(&loaded.goal) {
            self.start_locked(&mut state, goal_id).await;
        }
        Ok(())
    }

    pub async fn run_check(&self, goal_id: &str, milestone_id: &str) -> Result<(), DesktopError> {
        let lock = self.goal_lock(goal_id);
        let mut state = lock.lock().await;
        self.run_check_locked(&mut state, goal_id, milestone_id).await;
        Ok(())
    }

    /// Runs a milestone's check here. The verdict is the exit code; a failure
    /// becomes a delta with the command, the code and a two-line tail.
    pub(crate) async fn run_check_locked(&self, state: &mut GoalState, goal_id: &str, milestone_id: &str) {
        let Ok(loaded) = self.load(goal_id) else { return };
        let Some(index) = loaded.milestones.iter().position(|milestone| milestone.id == milestone_id) else { return };
        let milestone = loaded.milestones[index].clone();
        let Some(live) = self.live_for(&loaded.goal, false).await else {
            self.note(goal_id, "the check waits for the run's session", None);
            return;
        };
        // The agent may be running the same suite; two runs collide.
        if self.watch(&live.handle).is_some_and(|watch| !watch.idle()) {
            self.note(goal_id, "the check runs when the turn settles", None);
            return;
        }
        self.patch_runtime(goal_id, |runtime| {
            runtime.last_reason = format!("running the check for milestone {}", index + 1);
            runtime.ticking = true;
        });
        let root = live.root.clone();
        let kind = milestone.check_kind;
        let spec = milestone.check_spec.clone();
        let outcome = tokio::task::spawn_blocking(move || crate::odyssey_check::run_check(&root, kind, spec.as_deref())).await;
        let outcome = match outcome {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(error)) => {
                self.note(goal_id, &format!("the check could not be run: {}", error.message), None);
                return;
            }
            Err(_) => {
                self.note(goal_id, "the check could not be run", None);
                return;
            }
        };
        let evidence_text = if outcome.output.trim().is_empty() { outcome.summary.clone() } else { format!("{}\n\n{}", outcome.summary, outcome.output) };
        let _ = self.db(|storage| storage.milestone_record_check(milestone_id, outcome.passed, &evidence_text, CheckSource::Desktop));
        self.journal(goal_id, JournalKind::Check, Some(milestone_id), &format!("Super Thing ran the check for milestone {}: {}", index + 1, if outcome.passed { "passed" } else { "failed" }), Some(&outcome.summary));
        if outcome.passed {
            self.queue_delta(goal_id, Delta::Verified { milestone: index + 1, title: milestone.title.clone(), evidence: format!("{} (check run by Super Thing)", outcome.summary) });
        } else {
            let lines: Vec<&str> = outcome.output.split('\n').filter(|line| !line.is_empty()).collect();
            self.queue_delta(
                goal_id,
                Delta::CheckFailed {
                    milestone: index + 1,
                    title: milestone.title.clone(),
                    command: milestone.check_spec.clone().unwrap_or_else(|| outcome.summary.clone()),
                    exit_code: outcome.exit_code.map(i64::from).unwrap_or(-1),
                    tail: lines[lines.len().saturating_sub(2)..].join("\n"),
                },
            );
        }
        self.note(goal_id, &outcome.summary, None);
        self.changed(goal_id);
        // The check ran, so the milestone moved; a bare claim still means the
        // record did not take the verdict, and continuing would loop.
        let settled = self.load(goal_id).ok().and_then(|loaded| loaded.milestones.into_iter().find(|entry| entry.id == milestone_id));
        if settled.is_some_and(|entry| entry.state == MilestoneState::Reported) {
            let _ = self.set_state(goal_id, OdysseyState::Paused);
            self.journal(goal_id, JournalKind::State, None, &format!("The check for milestone {} ran ({}) but the milestone is still only reported", index + 1, outcome.summary), None);
            self.changed(goal_id);
            return;
        }
        let _ = state;
        if !outcome.passed || !decide::stops_after_milestone(&loaded.goal) {
            if loaded.goal.state != OdysseyState::Running {
                self.start_record(goal_id);
            }
            self.nudge(goal_id);
        } else if loaded.goal.state == OdysseyState::Running {
            let _ = self.set_state(goal_id, OdysseyState::Paused);
            self.journal(goal_id, JournalKind::State, None, &format!("Milestone {} is verified; this goal stops after each milestone", index + 1), None);
            self.notify(&loaded.goal, "done", &format!("milestone {} is verified", index + 1));
            self.changed(goal_id);
        }
    }

    /// Asks the session's model to turn the goal's plan document into
    /// milestones. The goal stays a draft until the user starts it.
    pub async fn request_plan(&self, goal_id: &str) -> Result<(), DesktopError> {
        let lock = self.goal_lock(goal_id);
        let mut state = lock.lock().await;
        let loaded = self.load(goal_id)?;
        let live = self.live_for(&loaded.goal, true).await.ok_or_else(|| DesktopError::not_ready("The run's session is not open."))?;
        if self.watch(&live.handle).is_some_and(|watch| !watch.idle()) {
            return Err(DesktopError::not_ready("The session is busy; wait for the current turn to finish."));
        }
        let document = self.db(|storage| storage.odyssey_plan_document(goal_id))?.ok_or_else(|| DesktopError::not_ready("This goal has no plan document to read."))?;
        let text = prompt::build_planning_prompt(&loaded.goal, &document, loaded.goal.plan_source.as_deref(), self.tools_available(&live));
        self.inner.inbox.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(goal_id);
        state.pending = Some(PendingTurn { handle: live.handle.clone(), tokens_at_submit: None, milestone: None, window_at_submit: None, provider: live.provider });
        match live.actor.submit_text(format!("superthing-plan-{}", uuid::Uuid::new_v4().simple()), &text).await? {
            SubmissionOutcome::Accepted => {}
            SubmissionOutcome::Rejected { error } | SubmissionOutcome::OutcomeUnknown { error } => {
                state.pending = None;
                return Err(error);
            }
        }
        self.journal(goal_id, JournalKind::Plan, None, PLAN_REQUESTED, loaded.goal.plan_source.as_deref());
        self.note(goal_id, "waiting for the agent's plan", None);
        self.changed(goal_id);
        Ok(())
    }

    /// Queues something for the model to fold into a running goal; carried on
    /// the next prompt, never submitted on its own.
    pub async fn add_amendment(&self, request: NewAmendment) -> Result<(), DesktopError> {
        let goal_id = request.odyssey_id.clone();
        self.db(|storage| storage.amendment_add(&request))?;
        let refs: Vec<String> = request.refs.iter().map(|reference| format!("{} ({}, {})", reference.path, reference.kind, reference.detail)).collect();
        let mut detail = vec![request.note.clone()];
        detail.extend(refs);
        self.journal(&goal_id, JournalKind::Plan, None, "You asked for a change to the plan", Some(&detail.join("\n")));
        self.changed(&goal_id);
        self.nudge(&goal_id);
        Ok(())
    }

    pub async fn decide_plan_change(&self, goal_id: &str, change_id: &str, apply: bool, note: Option<&str>) -> Result<(), DesktopError> {
        let lock = self.goal_lock(goal_id);
        let _state = lock.lock().await;
        let loaded = self.load(goal_id)?;
        let change = self.db(|storage| storage.plan_change_get(change_id))?.ok_or_else(|| DesktopError::not_ready("plan change not found"))?;
        if apply {
            // Resolved again now: the plan may have moved since the proposal.
            let ops: Vec<protocol::AmendOp> = serde_json::from_str(&change.ops).map_err(|error| DesktopError::io(format!("the proposal could not be read: {error}")))?;
            let resolved = protocol::resolve_ops(&ops, &loaded.milestones);
            self.db(|storage| storage.plan_change_decide(change_id, PlanChangeState::Applied, note))?;
            self.apply_resolved(&loaded.goal, &loaded.milestones, &resolved, &[]);
        } else {
            self.db(|storage| storage.plan_change_decide(change_id, PlanChangeState::Rejected, note))?;
            self.journal(goal_id, JournalKind::Plan, None, "You rejected the agent's plan change", Some(&[change.summary.clone(), note.unwrap_or("").to_string()].iter().filter(|line| !line.is_empty()).cloned().collect::<Vec<_>>().join("\n")));
            self.queue_delta(goal_id, Delta::PlanChangeRejected { summary: change.summary.split('\n').take(3).collect::<Vec<_>>().join("; "), note: note.map(str::trim).filter(|note| !note.is_empty()).map(str::to_string) });
        }
        self.changed(goal_id);
        Ok(())
    }

    pub async fn answer_question(&self, goal_id: &str, question_id: &str, answer: Option<&str>) -> Result<(), DesktopError> {
        let question = self.db(|storage| storage.question_get(question_id))?.ok_or_else(|| DesktopError::not_ready("question not found"))?;
        let answer = answer.map(str::trim).filter(|answer| !answer.is_empty());
        self.db(|storage| storage.question_settle(question_id, if answer.is_some() { QuestionState::Answered } else { QuestionState::Dismissed }, answer))?;
        self.journal(
            goal_id,
            JournalKind::Plan,
            None,
            if answer.is_some() { "You answered the agent's question" } else { "You dismissed the agent's question" },
            Some(&format!("{}\n{}", question.question, answer.unwrap_or("(no answer: the agent keeps its default)"))),
        );
        self.queue_delta(goal_id, Delta::QuestionAnswered { question: question.question, answer: answer.map(str::to_string) });
        self.changed(goal_id);
        self.nudge(goal_id);
        Ok(())
    }

    /// The briefing the goal's session would get now.
    pub async fn briefing_preview(&self, goal_id: &str) -> Result<String, DesktopError> {
        let loaded = self.load(goal_id)?;
        let live = self.live_for(&loaded.goal, false).await;
        Ok(self.briefing_for(&loaded, live.as_ref(), true))
    }
}

#[derive(Default)]
struct Carried {
    lines: Vec<String>,
    ids: Vec<String>,
    changes: bool,
}

fn phase_word(phase: TurnPhase) -> &'static str {
    match phase {
        TurnPhase::Succeeded => "succeeded",
        TurnPhase::Failed => "failed",
        TurnPhase::Cancelled => "cancelled",
        TurnPhase::Unknown => "ended unknown",
        _ => "ended",
    }
}

/// The orchestrator a run was started with.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamLead {
    #[serde(default)]
    pub provider: Option<Provider>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

/// A goal's own team: `{orchestrator, combo}`.
pub fn team_of(goal: &OdysseyRecord) -> Option<(TeamLead, Combo)> {
    let team = goal.team.as_ref()?;
    let lead: TeamLead = team.get("orchestrator").cloned().and_then(|value| serde_json::from_value(value).ok()).unwrap_or_default();
    let combo: Combo = team.get("combo").cloned().and_then(|value| serde_json::from_value(value).ok()).unwrap_or_default();
    Some((lead, combo.normalized()))
}
