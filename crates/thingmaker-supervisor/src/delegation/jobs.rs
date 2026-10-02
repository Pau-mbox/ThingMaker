//! Jobs: tasks an orchestrator handed to a worker, and the service that runs
//! them.
//!
//! A job is one turn of a worker session. The worker is an ordinary session
//! actor on whichever provider the combo named, opened by the host (which
//! knows how to find and launch each provider) through [`WorkerLauncher`].
//! The service submits the task, watches the worker's stream until the turn
//! settles, and keeps the worker's last message as the job's result. The
//! worker stays open, so a follow-up (`continue_job`) keeps its context.
//!
//! Everything is asynchronous on purpose: `delegate` answers with a job id at
//! once and `await_jobs` waits under a bound, because an MCP client gives up
//! on a tool call long before real work is done.

use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use super::combo::{Combo, QuotaBook, Route, WorkerSlot, route};
use crate::{
    DesktopError,
    acp::updates::{ContentBlock, SessionUpdate},
    agents::{Provider, events::QuotaSnapshot},
    supervisor::{SessionActor, SessionEvent, SubmissionOutcome, TurnEffect, TurnPhase},
};

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// Running jobs one orchestrator may have at once. More would be several
/// agent processes on one machine competing for the same files.
pub const MAX_RUNNING_JOBS: usize = 6;
/// The longest `await_jobs` blocks, whatever it is asked for. Below the tool
/// timeouts the providers are launched with.
pub const MAX_AWAIT: Duration = Duration::from_secs(20 * 60);
pub const DEFAULT_AWAIT: Duration = Duration::from_secs(5 * 60);
/// A result is the worker's report, not its transcript.
pub const RESULT_CHARS: usize = 24_000;
/// Jobs one worker session takes before it is closed and a fresh one opened:
/// reuse saves a start and keeps the provider's prompt cache warm, but each
/// job adds to the context the next one pays for.
pub const MAX_WORKER_REUSE: usize = 4;
/// How long a worker with nothing to do stays open for the next job.
pub const WORKER_IDLE: Duration = Duration::from_secs(5 * 60);
const TASK_CHARS: usize = 40_000;

/// What a job does when its worker hits a temporary limit — Codex's image
/// limit, an account window, an overloaded server: wait, then try again in
/// the same worker session, which keeps its context.
///
/// The wait is the provider's own reset time when it names one within
/// `max_wait_secs`, else `first_delay_secs`, growing by `step_secs` each try
/// up to `max_delay_secs`. After `max_attempts`, or once the job has waited
/// `max_wait_secs` in all, it fails and says why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RetryPolicy {
    pub enabled: bool,
    pub first_delay_secs: u64,
    pub step_secs: u64,
    pub max_delay_secs: u64,
    pub max_attempts: u32,
    pub max_wait_secs: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self { enabled: true, first_delay_secs: 300, step_secs: 300, max_delay_secs: 900, max_attempts: 6, max_wait_secs: 2 * 3600 }
    }
}

impl RetryPolicy {
    /// The wait before try `attempt` (1-based) when the provider names no reset.
    pub fn delay(&self, attempt: u32) -> Duration {
        let secs = self.first_delay_secs.saturating_add(self.step_secs.saturating_mul(u64::from(attempt.saturating_sub(1))));
        Duration::from_secs(secs.min(self.max_delay_secs.max(self.first_delay_secs)))
    }
}

/// A temporary limit a turn ran into, and when the provider says it lifts.
#[derive(Debug, Clone, PartialEq)]
struct Limit {
    reason: String,
    resets_at_unix_ms: Option<u64>,
    /// The capability it is a limit on (`image`), when it is not the account.
    capability: Option<&'static str>,
}

/// A wait the job is about to go through.
#[derive(Debug, Clone)]
struct Wait {
    limit: Limit,
    /// What the worker said before it stopped, kept if the job gives up.
    partial: Option<String>,
}

/// Why waiting ended without a retry.
enum Stop {
    Cancelled,
    GiveUp(String),
}


/// What the host is asked to open for a job.
#[derive(Debug, Clone)]
pub struct WorkerSpec {
    /// The orchestrator's attachment handle.
    pub orchestrator: String,
    pub root: PathBuf,
    pub slot: WorkerSlot,
    pub job_id: String,
    /// A name for the worker's session in the sidebar.
    pub title: String,
    /// The token the worker's own reduced `team` server authenticates with
    /// (memory and board, no delegation), for a provider that can load one.
    pub mcp_token: Option<String>,
}

/// Who is calling the `team` server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Caller {
    Orchestrator { session: String, provider: Provider, root: PathBuf },
    Worker { orchestrator: String, provider: Provider, root: PathBuf, name: String, job_id: String },
}

impl Caller {
    pub fn root(&self) -> &std::path::Path {
        match self {
            Self::Orchestrator { root, .. } | Self::Worker { root, .. } => root,
        }
    }

    /// The orchestrator session the call belongs to.
    pub fn orchestrator(&self) -> &str {
        match self {
            Self::Orchestrator { session, .. } => session,
            Self::Worker { orchestrator, .. } => orchestrator,
        }
    }

    pub fn provider(&self) -> Provider {
        match self {
            Self::Orchestrator { provider, .. } | Self::Worker { provider, .. } => *provider,
        }
    }

    /// How the caller signs what it writes: `claude`, or `codex · luna`.
    pub fn author(&self) -> String {
        match self {
            Self::Orchestrator { provider, .. } => format!("{} · orchestrator", provider.as_str()),
            Self::Worker { provider, name, .. } => format!("{} · {name}", provider.as_str()),
        }
    }
}

/// Tools another service answers on the same `team` server: Big Thing's
/// protocol, the shared memory and the board (ADR-010).
pub trait TeamExtension: Send + Sync {
    fn tools(&self, caller: &Caller) -> Vec<serde_json::Value>;
    /// Extra lines for the server's instructions.
    fn instructions(&self, caller: &Caller) -> Option<String>;
    /// The tool's result, or `None` when the tool is not this extension's.
    fn call(&self, caller: &Caller, name: &str, arguments: &serde_json::Value) -> Option<BoxFuture<serde_json::Value>>;
}

/// The host's side: opening a worker session, and forgetting one.
pub trait WorkerLauncher: Send + Sync {
    /// Opens a worker for `spec`. The actor is registered with the host like
    /// any other attachment, so the user can watch it.
    fn launch(&self, spec: WorkerSpec) -> BoxFuture<Result<SessionActor, DesktopError>>;
    /// A worker the service has stopped; the host drops its registration.
    fn released(&self, worker_handle: &str);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Starting,
    Running,
    /// Stopped by a temporary limit; tried again at `retry_at_unix_ms`.
    Waiting,
    Succeeded,
    Failed,
    Cancelled,
}

impl JobStatus {
    pub fn is_finished(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }

    /// Holding a worker process busy now (a waiting job is not).
    pub fn is_active(self) -> bool {
        matches!(self, Self::Starting | Self::Running)
    }
}

/// A job as the orchestrator and the UI see it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub id: String,
    /// The orchestrator's attachment handle.
    pub orchestrator: String,
    pub worker: String,
    pub provider: Provider,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub task: String,
    pub status: JobStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The worker asked for, when another one took the task, and why.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rerouted_from: Option<String>,
    /// The job this one follows up, in the same worker session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continues: Option<String>,
    /// The worker's attachment handle, once it is open.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_session: Option<String>,
    /// The id the worker's provider keeps its transcript under.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    pub tool_calls: u32,
    /// Retries after a temporary limit, so far.
    pub attempts: u32,
    /// What the job is waiting out, while it waits.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at_unix_ms: Option<u64>,
    pub started_at_unix_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at_unix_ms: Option<u64>,
    /// The worker's session was closed: idle too long, or its orchestrator ended.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub worker_closed: bool,
    /// Taken by a worker that had already done an earlier job, keeping its context.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub warm: bool,
}

/// What `delegate` takes.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DelegateArgs {
    pub task: String,
    #[serde(default)]
    pub worker: Option<String>,
    #[serde(default)]
    pub capability: Option<String>,
    #[serde(default)]
    pub files: Vec<String>,
    /// A finished job whose worker should take this as a follow-up.
    #[serde(default)]
    pub continue_job: Option<String>,
}

struct Orchestrator {
    provider: Provider,
    root: PathBuf,
    combo: Combo,
    token: String,
}

struct JobRecord {
    view: JobView,
    slot: WorkerSlot,
    actor: Option<SessionActor>,
    /// The worker's own MCP token, while its session is open.
    token: Option<String>,
}

struct WorkerIdentity {
    orchestrator: String,
    provider: Provider,
    root: PathBuf,
    name: String,
    job_id: String,
}

#[derive(Default)]
struct State {
    orchestrators: HashMap<String, Orchestrator>,
    tokens: HashMap<String, String>,
    worker_tokens: HashMap<String, WorkerIdentity>,
    jobs: HashMap<String, JobRecord>,
    /// Job ids per orchestrator, oldest first.
    order: HashMap<String, Vec<String>>,
    quotas: QuotaBook,
    serial: u64,
    retry: RetryPolicy,
}

struct Inner {
    launcher: Arc<dyn WorkerLauncher>,
    on_change: Box<dyn Fn(&JobView) + Send + Sync>,
    state: Mutex<State>,
    changed: watch::Sender<u64>,
    extension: std::sync::RwLock<Option<Arc<dyn TeamExtension>>>,
    reaper: std::sync::atomic::AtomicBool,
    idle: Mutex<Duration>,
}

/// The delegation service. Cloning shares it.
#[derive(Clone)]
pub struct Delegation {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Delegation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Delegation").finish_non_exhaustive()
    }
}

pub fn now_unix_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn cap(text: &str, chars: usize) -> String {
    if text.chars().count() <= chars {
        return text.to_string();
    }
    let head: String = text.chars().take(chars).collect();
    format!("{head}\n… [cut at {chars} characters]")
}

impl Delegation {
    /// `on_change` hears every change to every job, for the UI.
    pub fn new(launcher: Arc<dyn WorkerLauncher>, on_change: impl Fn(&JobView) + Send + Sync + 'static) -> Self {
        let (changed, _) = watch::channel(0);
        Self {
            inner: Arc::new(Inner {
                launcher,
                on_change: Box::new(on_change),
                state: Mutex::new(State::default()),
                changed,
                extension: std::sync::RwLock::new(None),
                reaper: std::sync::atomic::AtomicBool::new(false),
                idle: Mutex::new(WORKER_IDLE),
            }),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Makes `session` an orchestrator with `combo`, and returns the token
    /// its ThingMaker MCP server authenticates with. Registering again keeps the
    /// token and replaces the combo.
    pub fn register(&self, session: &str, provider: Provider, root: PathBuf, combo: Combo) -> String {
        let mut state = self.state();
        if let Some(existing) = state.orchestrators.get_mut(session) {
            existing.combo = combo.normalized();
            existing.provider = provider;
            existing.root = root;
            return existing.token.clone();
        }
        let token = uuid::Uuid::new_v4().simple().to_string();
        state.tokens.insert(token.clone(), session.to_string());
        state.orchestrators.insert(session.to_string(), Orchestrator { provider, root, combo: combo.normalized(), token: token.clone() });
        token
    }

    /// The orchestrator a token belongs to.
    pub fn session_for_token(&self, token: &str) -> Option<String> {
        self.state().tokens.get(token).cloned()
    }

    /// Who a token belongs to: an orchestrator, or one of its workers.
    pub fn caller_for_token(&self, token: &str) -> Option<Caller> {
        let state = self.state();
        if let Some(session) = state.tokens.get(token) {
            let orchestrator = state.orchestrators.get(session)?;
            return Some(Caller::Orchestrator { session: session.clone(), provider: orchestrator.provider, root: orchestrator.root.clone() });
        }
        let worker = state.worker_tokens.get(token)?;
        Some(Caller::Worker { orchestrator: worker.orchestrator.clone(), provider: worker.provider, root: worker.root.clone(), name: worker.name.clone(), job_id: worker.job_id.clone() })
    }

    /// Adds another service's tools to every `team` server.
    pub fn set_extension(&self, extension: Arc<dyn TeamExtension>) {
        *self.inner.extension.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(extension);
    }

    pub fn extension(&self) -> Option<Arc<dyn TeamExtension>> {
        self.inner.extension.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    /// The orchestrator's workspace root and provider.
    pub fn orchestrator_of(&self, session: &str) -> Option<(Provider, PathBuf)> {
        self.state().orchestrators.get(session).map(|orchestrator| (orchestrator.provider, orchestrator.root.clone()))
    }

    pub fn combo(&self, session: &str) -> Option<Combo> {
        self.state().orchestrators.get(session).map(|orchestrator| orchestrator.combo.clone())
    }

    /// Changes the team mid-session. The next `delegate` uses it; running
    /// jobs keep the worker they have.
    pub fn set_combo(&self, session: &str, combo: Combo) -> Result<Combo, DesktopError> {
        let mut state = self.state();
        let orchestrator = state.orchestrators.get_mut(session).ok_or_else(|| DesktopError::not_ready("this session has no team"))?;
        orchestrator.combo = combo.normalized();
        Ok(orchestrator.combo.clone())
    }

    /// The session is gone: its workers are stopped and its jobs forgotten.
    pub async fn release(&self, session: &str) {
        let (actors, finished) = {
            let mut state = self.state();
            let Some(orchestrator) = state.orchestrators.remove(session) else { return };
            state.tokens.remove(&orchestrator.token);
            state.worker_tokens.retain(|_, worker| worker.orchestrator != session);
            let ids = state.order.remove(session).unwrap_or_default();
            let mut actors = Vec::new();
            let mut finished = Vec::new();
            for id in ids {
                if let Some(mut record) = state.jobs.remove(&id) {
                    if !record.view.status.is_finished() {
                        record.view.status = JobStatus::Cancelled;
                        record.view.error = Some("the orchestrator session ended".into());
                        record.view.finished_at_unix_ms = Some(now_unix_ms());
                        finished.push(record.view.clone());
                    }
                    actors.extend(record.actor.take());
                }
            }
            (actors, finished)
        };
        for view in &finished {
            (self.inner.on_change)(view);
        }
        self.bump();
        let mut seen = std::collections::HashSet::new();
        for actor in actors {
            if seen.insert(actor.handle().id.clone()) {
                let _ = actor.stop().await;
                self.inner.launcher.released(&actor.handle().id);
            }
        }
    }

    /// A quota report from any session, orchestrator or worker.
    pub fn note_quota(&self, snapshot: QuotaSnapshot) {
        self.state().quotas.note(snapshot);
    }

    pub fn quota(&self, provider: Provider) -> Option<QuotaSnapshot> {
        self.state().quotas.get(provider).cloned()
    }

    /// Whether the provider is spent now, as far as any session has said.
    pub fn is_spent(&self, provider: Provider) -> bool {
        self.state().quotas.is_spent(provider, now_unix_ms())
    }

    /// The session's jobs, oldest first.
    pub fn jobs(&self, session: &str) -> Vec<JobView> {
        let state = self.state();
        state.order.get(session).into_iter().flatten().filter_map(|id| state.jobs.get(id)).map(|record| record.view.clone()).collect()
    }

    pub fn job(&self, session: &str, id: &str) -> Result<JobView, String> {
        let state = self.state();
        match state.jobs.get(id) {
            Some(record) if record.view.orchestrator == session => Ok(record.view.clone()),
            _ => Err(format!("No job {id:?} in this session.")),
        }
    }

    fn bump(&self) {
        self.inner.changed.send_modify(|value| *value = value.wrapping_add(1));
    }

    fn update(&self, id: &str, change: impl FnOnce(&mut JobRecord)) {
        let view = {
            let mut state = self.state();
            let Some(record) = state.jobs.get_mut(id) else { return };
            change(record);
            record.view.clone()
        };
        (self.inner.on_change)(&view);
        self.bump();
    }

    /// Starts a job and answers at once with its view.
    pub fn delegate(&self, session: &str, args: DelegateArgs) -> Result<JobView, String> {
        let task = args.task.trim();
        if task.is_empty() {
            return Err("The task is empty. Describe the work the worker should do.".into());
        }
        let now = now_unix_ms();
        let mut queued: Option<(Wait, u64)> = None;
        let (view, slot, reuse, root, orchestrator_provider) = {
            let mut state = self.state();
            let Some(orchestrator) = state.orchestrators.get(session) else {
                return Err("This session is not an orchestrator in ThingMaker.".into());
            };
            let root = orchestrator.root.clone();
            let orchestrator_provider = orchestrator.provider;
            let combo = orchestrator.combo.clone();
            let running = state
                .order
                .get(session)
                .into_iter()
                .flatten()
                .filter(|id| state.jobs.get(*id).is_some_and(|record| record.view.status.is_active()))
                .count();
            if running >= MAX_RUNNING_JOBS {
                return Err(format!("{running} jobs are already running; await some before delegating more."));
            }
            let (route, reuse) = match args.continue_job.as_deref().filter(|id| !id.trim().is_empty()) {
                Some(previous) => {
                    let Some(record) = state.jobs.get(previous).filter(|record| record.view.orchestrator == session) else {
                        return Err(format!("No job {previous:?} to continue in this session."));
                    };
                    if !record.view.status.is_finished() {
                        return Err(format!("Job {previous} is still running; await it first."));
                    }
                    let Some(actor) = record.actor.clone() else {
                        return Err(format!("Job {previous}'s worker is no longer open; delegate a new job instead."));
                    };
                    if state.jobs.values().any(|other| !other.view.status.is_finished() && other.view.worker_session.as_deref() == Some(actor.handle().id.as_str())) {
                        return Err(format!("Job {previous}'s worker is busy with another follow-up."));
                    }
                    (Route { slot: record.slot.clone(), rerouted_from: None }, Some((previous.to_string(), actor)))
                }
                None => match route(&combo, args.worker.as_deref(), args.capability.as_deref(), &state.quotas, &[], now) {
                    Ok(route) => (route, None),
                    Err(error) => {
                        // Only limits in the way: the job is queued to wait
                        // them out rather than refused.
                        let open = route(&combo, args.worker.as_deref(), args.capability.as_deref(), &QuotaBook::default(), &[], now).ok().filter(|_| state.retry.enabled);
                        let Some(open) = open else { return Err(error) };
                        let resets = state.quotas.available_again_ms(open.slot.provider, now).or_else(|| {
                            args.capability.as_deref().and_then(|capability| state.quotas.capability_blocked(open.slot.provider, capability, now))
                        });
                        let limit = Limit { reason: error, resets_at_unix_ms: resets, capability: None };
                        // Planned now, so the caller hears of a wait that is
                        // longer than the policy allows before a job exists.
                        let retry_at = plan_wait(&state.retry, 1, &limit, now, now)?;
                        queued = Some((Wait { limit, partial: None }, retry_at));
                        (open, None)
                    }
                },
            };
            // A worker that finished an earlier job on the same slot and has
            // nothing to do takes this one: no start, and a warm cache.
            let warm = if reuse.is_none() && queued.is_none() { warm_worker(&state, session, &route.slot) } else { None };
            let reuse = reuse.or_else(|| warm.clone().map(|actor| (String::new(), actor)));
            state.serial += 1;
            let id = format!("job-{}", state.serial);
            let view = JobView {
                id: id.clone(),
                orchestrator: session.to_string(),
                worker: route.slot.name.clone(),
                provider: route.slot.provider,
                model: route.slot.model.clone(),
                effort: route.slot.effort.clone(),
                task: cap(task, 2_000),
                status: if queued.is_some() { JobStatus::Waiting } else { JobStatus::Starting },
                result: None,
                error: None,
                rerouted_from: route.rerouted_from.clone(),
                continues: reuse.as_ref().map(|(previous, _)| previous.clone()).filter(|previous| !previous.is_empty()),
                worker_session: reuse.as_ref().map(|(_, actor)| actor.handle().id.clone()),
                agent_session_id: None,
                tool_calls: 0,
                attempts: 0,
                waiting_reason: queued.as_ref().map(|(wait, _)| wait.limit.reason.clone()),
                retry_at_unix_ms: queued.as_ref().map(|(_, at)| *at),
                started_at_unix_ms: now,
                finished_at_unix_ms: None,
                worker_closed: false,
                warm: warm.is_some(),
            };
            let token = reuse.is_none().then(|| uuid::Uuid::new_v4().simple().to_string());
            if let Some(token) = &token {
                state.worker_tokens.insert(
                    token.clone(),
                    WorkerIdentity { orchestrator: session.to_string(), provider: route.slot.provider, root: root.clone(), name: route.slot.name.clone(), job_id: id.clone() },
                );
            }
            state.jobs.insert(id.clone(), JobRecord { view: view.clone(), slot: route.slot.clone(), actor: reuse.as_ref().map(|(_, actor)| actor.clone()), token });
            state.order.entry(session.to_string()).or_default().push(id);
            (view, route.slot, reuse.map(|(_, actor)| actor), root, orchestrator_provider)
        };
        (self.inner.on_change)(&view);
        self.bump();
        let mut prompt = worker_prompt(task, &args.files, orchestrator_provider, view.continues.is_some());
        if view.warm {
            prompt = format!("Your previous task is finished. This is a new one: treat it on its own, using what you learned only where it applies.\n\n{prompt}");
        }
        self.ensure_reaper();
        let service = self.clone();
        let job_id = view.id.clone();
        let summary: String = task.lines().next().unwrap_or(task).chars().take(60).collect();
        let title = format!("{} · {summary}", slot.name);
        let mcp_token = self.state().jobs.get(&job_id).and_then(|record| record.token.clone());
        let spec = WorkerSpec { orchestrator: session.to_string(), root, slot, job_id: job_id.clone(), title, mcp_token };
        let queued = queued.map(|(wait, _)| wait);
        tokio::spawn(async move { service.run(job_id, spec, prompt, reuse, args, queued).await });
        Ok(view)
    }

    async fn run(&self, job_id: String, spec: WorkerSpec, prompt: String, reuse: Option<SessionActor>, args: DelegateArgs, queued: Option<Wait>) {
        let mut spec = spec;
        let mut excluded: Vec<Provider> = Vec::new();
        let mut actor = reuse;
        let mut wait = queued;
        let mut attempt = 0u32;
        let mut next_prompt = prompt.clone();
        loop {
            if let Some(pending) = wait.take() {
                attempt += 1;
                match self.wait_for_retry(&job_id, attempt, &pending.limit).await {
                    Ok(()) => {}
                    Err(Stop::Cancelled) => return,
                    Err(Stop::GiveUp(why)) => {
                        self.finish(&job_id, JobStatus::Failed, pending.partial, Some(why));
                        return;
                    }
                }
                // Nothing open yet (the job was queued): the team and the
                // limits may have changed while it waited, so route again.
                if actor.is_none() {
                    let routed = {
                        let state = self.state();
                        state
                            .orchestrators
                            .get(&spec.orchestrator)
                            .map(|orchestrator| route(&orchestrator.combo, args.worker.as_deref(), args.capability.as_deref(), &state.quotas, &excluded, now_unix_ms()))
                    };
                    match routed {
                        Some(Ok(next)) => {
                            spec.slot = next.slot.clone();
                            self.update(&job_id, |record| {
                                record.slot = next.slot.clone();
                                record.view.worker = next.slot.name.clone();
                                record.view.provider = next.slot.provider;
                                record.view.model = next.slot.model.clone();
                                record.view.effort = next.slot.effort.clone();
                            });
                        }
                        Some(Err(reason)) => {
                            let resets = {
                                let state = self.state();
                                let now = now_unix_ms();
                                state.quotas.available_again_ms(spec.slot.provider, now).or_else(|| {
                                    args.capability.as_deref().and_then(|capability| state.quotas.capability_blocked(spec.slot.provider, capability, now))
                                })
                            };
                            wait = Some(Wait { limit: Limit { reason, resets_at_unix_ms: resets, capability: None }, partial: None });
                            continue;
                        }
                        None => {
                            self.finish(&job_id, JobStatus::Cancelled, None, Some("the orchestrator session ended".into()));
                            return;
                        }
                    }
                }
            }
            let worker = match actor.take() {
                Some(worker) => worker,
                None => match self.inner.launcher.launch(spec.clone()).await {
                    Ok(worker) => worker,
                    Err(error) => {
                        self.finish(&job_id, JobStatus::Failed, None, Some(format!("{} could not start: {}", spec.slot.describe(), error.message)));
                        return;
                    }
                },
            };
            let handle = worker.handle().id.clone();
            let agent_session_id = worker.snapshot().await.ok().and_then(|snapshot| snapshot.agent_session_id);
            self.update(&job_id, |record| {
                record.actor = Some(worker.clone());
                record.view.worker_session = Some(handle.clone());
                record.view.agent_session_id = agent_session_id.clone();
                if record.view.status != JobStatus::Cancelled {
                    record.view.status = JobStatus::Running;
                }
            });
            if self.cancelled(&job_id) {
                let _ = worker.cancel().await;
                return;
            }
            let outcome = self.turn(&job_id, &worker, &next_prompt).await;
            match outcome {
                TurnOutcome::Done { text, limited: None } => {
                    self.finish(&job_id, JobStatus::Succeeded, Some(text), None);
                    return;
                }
                TurnOutcome::Done { text, limited: Some(limit) } => {
                    // The turn ended, but what it was for did not happen: the
                    // image tool's own limit. New jobs that need it wait too.
                    let policy = self.state().retry;
                    if let Some(capability) = limit.capability {
                        let until = limit.resets_at_unix_ms.unwrap_or_else(|| now_unix_ms() + policy.delay(attempt + 1).as_millis() as u64);
                        self.state().quotas.block_capability(spec.slot.provider, capability, until);
                    }
                    if !policy.enabled {
                        self.finish(&job_id, JobStatus::Failed, Some(text), Some(limit.reason));
                        return;
                    }
                    actor = Some(worker);
                    next_prompt = resume_prompt(&limit.reason);
                    wait = Some(Wait { limit, partial: Some(text) });
                }
                TurnOutcome::Cancelled => {
                    self.finish(&job_id, JobStatus::Cancelled, None, Some("cancelled".into()));
                    return;
                }
                TurnOutcome::Failed { error, rate_limited, produced, transient } => {
                    if rate_limited {
                        self.state().quotas.note_refusal(spec.slot.provider, now_unix_ms());
                    }
                    // A refusal before any work moves the job to another
                    // worker that fits, once per provider. A follow-up stays:
                    // its context is in this worker.
                    if rate_limited && !produced && args.continue_job.is_none() {
                        excluded.push(spec.slot.provider);
                        let next = {
                            let state = self.state();
                            state.orchestrators.get(&spec.orchestrator).map(|orchestrator| match args.capability.as_deref() {
                                Some(capability) => route(&orchestrator.combo, None, Some(capability), &state.quotas, &excluded, now_unix_ms()),
                                // By the refused worker's name: the router finds
                                // one that shares a capability with it.
                                None => route(&orchestrator.combo, Some(&spec.slot.name), None, &state.quotas, &excluded, now_unix_ms()),
                            })
                        };
                        if let Some(Ok(next)) = next {
                            let from = format!("{} ({} refused: {})", spec.slot.name, spec.slot.provider.label(), cap(&error, 200));
                            self.release_worker(&job_id, &worker).await;
                            spec.slot = next.slot.clone();
                            self.update(&job_id, |record| {
                                record.slot = next.slot.clone();
                                record.view.worker = next.slot.name.clone();
                                record.view.provider = next.slot.provider;
                                record.view.model = next.slot.model.clone();
                                record.view.effort = next.slot.effort.clone();
                                record.view.rerouted_from = Some(from);
                                record.view.status = JobStatus::Starting;
                                record.view.worker_session = None;
                                record.view.agent_session_id = None;
                            });
                            continue;
                        }
                        // Nobody else can take it: this worker waits the
                        // limit out instead.
                        excluded.retain(|provider| *provider != spec.slot.provider);
                    }
                    if (rate_limited || transient) && self.state().retry.enabled {
                        let resets = if rate_limited { self.state().quotas.available_again_ms(spec.slot.provider, now_unix_ms()) } else { None };
                        let reason = if rate_limited {
                            format!("{} is out of quota", spec.slot.provider.label())
                        } else {
                            format!("{} had a temporary error ({})", spec.slot.provider.label(), cap(&error, 160))
                        };
                        actor = Some(worker);
                        next_prompt = if produced { resume_prompt(&reason) } else { prompt.clone() };
                        wait = Some(Wait { limit: Limit { reason, resets_at_unix_ms: resets, capability: None }, partial: None });
                        continue;
                    }
                    self.finish(&job_id, JobStatus::Failed, None, Some(error));
                    return;
                }
            }
        }
    }

    /// Parks a job until its retry time, or until it is cancelled or retried
    /// now. Fails it when the policy says waiting is over.
    async fn wait_for_retry(&self, job_id: &str, attempt: u32, limit: &Limit) -> Result<(), Stop> {
        let (policy, started) = {
            let state = self.state();
            let started = state.jobs.get(job_id).map(|record| record.view.started_at_unix_ms).unwrap_or_else(now_unix_ms);
            (state.retry, started)
        };
        if !policy.enabled {
            return Err(Stop::GiveUp(format!("{}; waiting and retrying is turned off", limit.reason)));
        }
        if attempt > policy.max_attempts {
            return Err(Stop::GiveUp(format!("{}; gave up after {} retries", limit.reason, policy.max_attempts)));
        }
        let retry_at = plan_wait(&policy, attempt, limit, started, now_unix_ms()).map_err(Stop::GiveUp)?;
        self.update(job_id, |record| {
            if record.view.status == JobStatus::Cancelled {
                return;
            }
            record.view.status = JobStatus::Waiting;
            record.view.attempts = attempt;
            record.view.waiting_reason = Some(limit.reason.clone());
            // A queued job already planned this wait; keep the time it was told.
            record.view.retry_at_unix_ms = Some(record.view.retry_at_unix_ms.filter(|_| attempt == 1).unwrap_or(retry_at));
        });
        loop {
            let (status, due) = {
                let state = self.state();
                match state.jobs.get(job_id) {
                    Some(record) => (record.view.status, record.view.retry_at_unix_ms.unwrap_or(0)),
                    None => return Err(Stop::Cancelled),
                }
            };
            if status == JobStatus::Cancelled {
                return Err(Stop::Cancelled);
            }
            let now = now_unix_ms();
            if now >= due {
                break;
            }
            tokio::time::sleep(Duration::from_millis((due - now).min(1000))).await;
        }
        self.update(job_id, |record| {
            if record.view.status == JobStatus::Waiting {
                record.view.status = JobStatus::Starting;
            }
            record.view.waiting_reason = None;
            record.view.retry_at_unix_ms = None;
        });
        Ok(())
    }

    /// Ends a job's wait now (the user knows the limit has lifted).
    pub fn retry_now(&self, session: &str, id: &str) -> Result<JobView, String> {
        let view = self.job(session, id)?;
        if view.status != JobStatus::Waiting {
            return Err(format!("Job {id} is not waiting."));
        }
        self.update(id, |record| record.view.retry_at_unix_ms = Some(now_unix_ms()));
        self.job(session, id)
    }

    pub fn retry_policy(&self) -> RetryPolicy {
        self.state().retry
    }

    pub fn set_retry_policy(&self, policy: RetryPolicy) {
        self.state().retry = policy;
    }

    /// How long an idle worker stays open (tests shorten it).
    pub fn set_worker_idle(&self, idle: Duration) {
        *self.inner.idle.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = idle;
    }

    /// Starts the loop that closes idle workers, once.
    fn ensure_reaper(&self) {
        use std::sync::atomic::Ordering;
        if self.inner.reaper.swap(true, Ordering::SeqCst) {
            return;
        }
        let weak = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            loop {
                let pause = weak.upgrade().map(|inner| (*inner.idle.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) / 4).clamp(Duration::from_millis(200), Duration::from_secs(30)));
                let Some(pause) = pause else { break };
                tokio::time::sleep(pause).await;
                let Some(inner) = weak.upgrade() else { break };
                Delegation { inner }.reap_idle().await;
            }
        });
    }

    /// Closes the workers that have had nothing to do for longer than the
    /// idle time. A closed worker's jobs keep their reports; a follow-up to one
    /// of them starts a new worker.
    pub async fn reap_idle(&self) {
        let idle = *self.inner.idle.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = now_unix_ms();
        let (closing, views) = {
            let mut state = self.state();
            let mut handles: HashMap<String, (SessionActor, u64, bool)> = HashMap::new();
            for record in state.jobs.values() {
                let (Some(handle), Some(actor)) = (record.view.worker_session.clone(), record.actor.clone()) else { continue };
                let entry = handles.entry(handle).or_insert((actor, 0, false));
                entry.1 = entry.1.max(record.view.finished_at_unix_ms.unwrap_or(now));
                entry.2 |= !record.view.status.is_finished();
            }
            // A worker another unfinished job points at is in use, whether
            // or not that record holds the actor.
            let busy: Vec<String> = state.jobs.values().filter(|record| !record.view.status.is_finished()).filter_map(|record| record.view.worker_session.clone()).collect();
            let closing: Vec<(String, SessionActor)> = handles
                .into_iter()
                .filter(|(handle, (_, finished, active))| !active && !busy.contains(handle) && now.saturating_sub(*finished) >= idle.as_millis() as u64)
                .map(|(handle, (actor, _, _))| (handle, actor))
                .collect();
            let mut views = Vec::new();
            for (handle, _) in &closing {
                let mut tokens = Vec::new();
                for record in state.jobs.values_mut() {
                    if record.view.worker_session.as_deref() == Some(handle.as_str()) {
                        record.actor = None;
                        record.view.worker_closed = true;
                        tokens.extend(record.token.take());
                        views.push(record.view.clone());
                    }
                }
                for token in tokens {
                    state.worker_tokens.remove(&token);
                }
            }
            (closing, views)
        };
        for (handle, actor) in closing {
            let _ = actor.stop().await;
            self.inner.launcher.released(&handle);
        }
        for view in views {
            (self.inner.on_change)(&view);
        }
        self.bump();
    }

    async fn release_worker(&self, job_id: &str, worker: &SessionActor) {
        let token = {
            let mut state = self.state();
            let token = state.jobs.values_mut().find(|record| record.actor.as_ref().is_some_and(|actor| actor.handle().id == worker.handle().id) && record.token.is_some()).and_then(|record| record.token.take());
            if let Some(token) = &token {
                state.worker_tokens.remove(token);
            }
            token
        };
        let _ = token;
        // Every job that held this worker lets go of it, so none hands a
        // stopped session to the next one.
        {
            let mut state = self.state();
            for record in state.jobs.values_mut() {
                if record.actor.as_ref().is_some_and(|actor| actor.handle().id == worker.handle().id) {
                    record.actor = None;
                }
            }
        }
        self.update(job_id, |record| record.actor = None);
        let _ = worker.stop().await;
        self.inner.launcher.released(&worker.handle().id);
    }

    fn cancelled(&self, job_id: &str) -> bool {
        self.state().jobs.get(job_id).is_some_and(|record| record.view.status == JobStatus::Cancelled)
    }

    fn finish(&self, job_id: &str, status: JobStatus, result: Option<String>, error: Option<String>) {
        self.update(job_id, |record| {
            // A cancel that arrived first stands.
            if record.view.status == JobStatus::Cancelled {
                return;
            }
            record.view.status = status;
            record.view.result = result.map(|text| cap(&text, RESULT_CHARS));
            record.view.error = error;
            record.view.finished_at_unix_ms = Some(now_unix_ms());
        });
    }

    /// One worker turn: submit, then read the stream until it settles.
    async fn turn(&self, job_id: &str, worker: &SessionActor, prompt: &str) -> TurnOutcome {
        let mut subscription = worker.subscribe();
        match worker.submit_text(format!("{job_id}-{}", now_unix_ms()), prompt).await {
            Ok(SubmissionOutcome::Accepted) => {}
            Ok(SubmissionOutcome::Rejected { error }) | Ok(SubmissionOutcome::OutcomeUnknown { error }) | Err(error) => {
                return TurnOutcome::Failed { error: format!("the worker did not take the task: {}", error.message), rate_limited: false, produced: false, transient: false };
            }
        }
        let mut messages: Vec<(String, String)> = Vec::new();
        let mut tool_calls = std::collections::HashSet::new();
        let mut image_limit: Option<Limit> = None;
        let mut image_made = false;
        while let Some(event) = subscription.recv().await {
            match &event.payload {
                SessionEvent::Update(SessionUpdate::AgentMessage(message)) => {
                    let text: String = message.content.iter().filter_map(|block| if let ContentBlock::Text { text } = block { Some(text.as_str()) } else { None }).collect();
                    match messages.iter_mut().find(|(id, _)| *id == message.message_id) {
                        Some((_, existing)) if message.replace => *existing = text,
                        Some((_, existing)) => existing.push_str(&text),
                        None => messages.push((message.message_id.clone(), text)),
                    }
                }
                SessionEvent::Update(SessionUpdate::ToolCall(patch)) | SessionEvent::Update(SessionUpdate::ToolCallUpdate(patch)) => {
                    match image_outcome(patch.raw_output.as_ref()) {
                        Some(ImageOutcome::Made) => image_made = true,
                        Some(ImageOutcome::Limited(limit)) => image_limit = Some(limit),
                        None => {}
                    }
                    if let Some(id) = &patch.tool_call_id
                        && tool_calls.insert(id.clone())
                    {
                        let count = tool_calls.len() as u32;
                        self.update(job_id, |record| record.view.tool_calls = count);
                    }
                }
                SessionEvent::Quota(snapshot) => self.note_quota(snapshot.clone()),
                SessionEvent::Turn(TurnEffect::Settled { phase, error, stop_reason, .. }) => {
                    let text = messages.iter().rev().map(|(_, text)| text.trim()).find(|text| !text.is_empty()).unwrap_or("").to_string();
                    let produced = !text.is_empty() || !tool_calls.is_empty();
                    // An image the tool refused for its limit, and none made
                    // since: what the task was for did not happen.
                    let limited = if image_made { None } else { image_limit.clone() };
                    return match phase {
                        TurnPhase::Succeeded => TurnOutcome::Done { text: if text.is_empty() { "(the worker finished without a report)".into() } else { text }, limited },
                        TurnPhase::Cancelled => TurnOutcome::Cancelled,
                        _ => {
                            let error = error.clone().or_else(|| stop_reason.clone()).unwrap_or_else(|| format!("the turn ended as {phase:?}"));
                            let rate_limited = looks_rate_limited(&error);
                            let transient = !rate_limited && looks_transient(&error);
                            TurnOutcome::Failed { error, rate_limited, produced, transient }
                        }
                    };
                }
                SessionEvent::SnapshotNeeded { .. } => {
                    // Lagged past the settle, perhaps: the actor knows.
                    if let Ok(snapshot) = worker.snapshot().await
                        && !snapshot.foreground.is_active()
                        && snapshot.foreground != TurnPhase::Idle
                    {
                        let text = messages.iter().rev().map(|(_, text)| text.trim()).find(|text| !text.is_empty()).unwrap_or("").to_string();
                        return match snapshot.foreground {
                            TurnPhase::Succeeded => TurnOutcome::Done { text, limited: if image_made { None } else { image_limit.clone() } },
                            TurnPhase::Cancelled => TurnOutcome::Cancelled,
                            phase => TurnOutcome::Failed { error: format!("the turn ended as {phase:?}"), rate_limited: false, produced: !text.is_empty(), transient: false },
                        };
                    }
                }
                SessionEvent::Exited(_) => {
                    return TurnOutcome::Failed { error: "the worker's process exited".into(), rate_limited: false, produced: !messages.is_empty(), transient: false };
                }
                _ => {}
            }
        }
        TurnOutcome::Failed { error: "the worker's event stream closed".into(), rate_limited: false, produced: !messages.is_empty(), transient: false }
    }

    /// Cancels a job; its worker's turn is interrupted.
    pub async fn cancel(&self, session: &str, id: &str) -> Result<JobView, String> {
        let view = self.job(session, id)?;
        if view.status.is_finished() {
            return Ok(view);
        }
        let actor = self.state().jobs.get(id).and_then(|record| record.actor.clone());
        self.update(id, |record| {
            record.view.status = JobStatus::Cancelled;
            record.view.error = Some("cancelled".into());
            record.view.finished_at_unix_ms = Some(now_unix_ms());
        });
        if let Some(actor) = actor {
            let _ = actor.cancel().await;
        }
        self.job(session, id)
    }

    /// Waits until the jobs are finished (all of them, or any one with
    /// `any`), or `timeout` passes, and returns them as they are then. No ids
    /// means every unfinished job in the session.
    pub async fn await_jobs(&self, session: &str, ids: &[String], timeout: Duration, any: bool) -> Result<Vec<JobView>, String> {
        let ids: Vec<String> = if ids.is_empty() {
            self.jobs(session).into_iter().filter(|job| !job.status.is_finished()).map(|job| job.id).collect()
        } else {
            for id in ids {
                self.job(session, id)?;
            }
            ids.to_vec()
        };
        let deadline = tokio::time::Instant::now() + timeout.min(MAX_AWAIT);
        let mut changed = self.inner.changed.subscribe();
        loop {
            let views: Vec<JobView> = ids.iter().filter_map(|id| self.job(session, id).ok()).collect();
            let finished = views.iter().filter(|job| job.status.is_finished()).count();
            let done = if any { finished > 0 || views.is_empty() } else { finished == views.len() };
            if done {
                return Ok(views);
            }
            match tokio::time::timeout_at(deadline, changed.changed()).await {
                Ok(Ok(())) => {}
                _ => return Ok(views),
            }
        }
    }

    /// The team as the orchestrator reads it, with each provider's headroom.
    pub fn list_workers(&self, session: &str) -> Result<serde_json::Value, String> {
        let state = self.state();
        let Some(orchestrator) = state.orchestrators.get(session) else {
            return Err("This session is not an orchestrator in ThingMaker.".into());
        };
        let now = now_unix_ms();
        let workers: Vec<serde_json::Value> = orchestrator
            .combo
            .workers
            .iter()
            .map(|slot| {
                let quota = state.quotas.get(slot.provider);
                let availability = if state.quotas.is_spent(slot.provider, now) {
                    let until = quota.and_then(QuotaSnapshot::available_again_at).map(super::combo::format_reset);
                    match until {
                        Some(until) => format!("out of quota until {until}"),
                        None => "out of quota".to_string(),
                    }
                } else {
                    match quota.map(|_| state.quotas.pressure(slot.provider)) {
                        Some(used) => format!("available ({used:.0}% of the tightest window used)"),
                        None => "available".to_string(),
                    }
                };
                serde_json::json!({
                    "name": slot.name,
                    "provider": slot.provider.as_str(),
                    "model": slot.model,
                    "effort": slot.effort,
                    "capabilities": slot.capabilities,
                    "note": slot.note,
                    "availability": availability,
                })
            })
            .collect();
        let running = state.order.get(session).into_iter().flatten().filter(|id| state.jobs.get(*id).is_some_and(|record| !record.view.status.is_finished())).count();
        Ok(serde_json::json!({
            "orchestrator": orchestrator.provider.as_str(),
            "workers": workers,
            "runningJobs": running,
            "maxRunningJobs": MAX_RUNNING_JOBS,
        }))
    }
}

enum TurnOutcome {
    /// The turn ended. `limited` is set when it ended without doing what it
    /// was for because of a limit of its own (Codex's image tool).
    Done { text: String, limited: Option<Limit> },
    Cancelled,
    /// `transient`: a server-side hiccup worth waiting out (overloaded,
    /// dropped stream), as opposed to the account's limit (`rate_limited`).
    Failed { error: String, rate_limited: bool, produced: bool, transient: bool },
}

enum ImageOutcome {
    Made,
    Limited(Limit),
}

/// What an image tool call came to, from Codex's `imageGeneration` item as
/// the bridge reports it: a `savedPath`, or a `failure` of type
/// `usageLimitExceeded` with the time it resets.
fn image_outcome(output: Option<&serde_json::Value>) -> Option<ImageOutcome> {
    let output = output?;
    if output.get("savedPath").and_then(serde_json::Value::as_str).is_some_and(|path| !path.is_empty()) {
        return Some(ImageOutcome::Made);
    }
    let failure = output.get("failure").filter(|failure| failure.is_object())?;
    if failure.get("type").and_then(serde_json::Value::as_str) != Some("usageLimitExceeded") {
        return None;
    }
    let resets = failure.get("resetsAt").and_then(serde_json::Value::as_u64).map(|seconds| seconds.saturating_mul(1000));
    Some(ImageOutcome::Limited(Limit { reason: "Codex's image generation limit is spent".into(), resets_at_unix_ms: resets, capability: Some("image") }))
}

/// When to try again: the provider's reset (with a minute's margin) when it
/// names one within the policy's patience, else the policy's delay for this
/// attempt. An error when the reset is further off than that, or the job has
/// already waited as long as the policy allows.
fn plan_wait(policy: &RetryPolicy, attempt: u32, limit: &Limit, started_unix_ms: u64, now_unix_ms: u64) -> Result<u64, String> {
    let deadline = started_unix_ms.saturating_add(policy.max_wait_secs.saturating_mul(1000));
    if now_unix_ms >= deadline {
        return Err(format!("{}; gave up after waiting {} min", limit.reason, policy.max_wait_secs / 60));
    }
    let retry_at = match limit.resets_at_unix_ms {
        // A minute past the reset, or the first delay when that is shorter.
        Some(reset) if reset > now_unix_ms => reset.saturating_add(60_000.min(policy.first_delay_secs.saturating_mul(1000))),
        _ => now_unix_ms.saturating_add(policy.delay(attempt).as_millis() as u64),
    };
    if retry_at > deadline {
        return Err(format!(
            "{}; it lifts at {}, later than the {} min a job waits",
            limit.reason,
            super::combo::format_reset(retry_at / 1000),
            policy.max_wait_secs / 60
        ));
    }
    Ok(retry_at)
}

/// What a worker is told when it is woken after a limit.
fn resume_prompt(reason: &str) -> String {
    format!(
        "You were stopped by a temporary limit ({reason}). It should have lifted now: carry on with the task where you left off and finish it. \
As before, end with your report: what you did, the files you created or changed, and anything to check."
    )
}

/// A failure worth waiting out that is not the account's limit.
pub fn looks_transient(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    ["serveroverloaded", "overloaded", "responsetoomanyfailedattempts", "responsestreamdisconnected", "httpconnectionfailed", "responsestreamconnectionfailed", "internalservererror"]
        .iter()
        .any(|needle| lower.contains(needle))
}


/// Whether a failed turn was the account's limit rather than the work: the
/// Codex bridge says `rate_limit`, Claude Code says it in words.
pub fn looks_rate_limited(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    ["rate_limit", "rate limit", "usage limit", "hit your", "quota", "limit reached", "usagelimitexceeded"].iter().any(|needle| lower.contains(needle))
}

/// What a worker is told. It has none of the orchestrator's conversation, so
/// the task has to stand alone; and its last message is its report, so it is
/// asked to make that message one.
/// A worker that finished an earlier job on this slot, is free, and has not
/// taken its share of jobs yet.
fn warm_worker(state: &State, session: &str, slot: &WorkerSlot) -> Option<SessionActor> {
    let ids = state.order.get(session)?;
    for id in ids.iter().rev() {
        let Some(record) = state.jobs.get(id) else { continue };
        if record.view.status != JobStatus::Succeeded || record.view.worker_closed {
            continue;
        }
        let Some(actor) = &record.actor else { continue };
        if record.slot.name != slot.name || record.slot.provider != slot.provider || record.slot.model != slot.model || record.slot.effort != slot.effort {
            continue;
        }
        let handle = actor.handle().id.as_str();
        let uses = state.jobs.values().filter(|other| other.view.worker_session.as_deref() == Some(handle));
        let mut count = 0;
        let mut busy = false;
        for other in uses {
            count += 1;
            busy |= !other.view.status.is_finished();
        }
        if busy || count >= MAX_WORKER_REUSE {
            continue;
        }
        return Some(actor.clone());
    }
    None
}

pub fn worker_prompt(task: &str, files: &[String], orchestrator: Provider, follow_up: bool) -> String {
    let mut prompt = String::new();
    if follow_up {
        prompt.push_str("Follow-up from the orchestrator on the task you just did:\n\n");
    } else {
        prompt.push_str(&format!(
            "You are a worker on a team in ThingMaker, the user's desktop for several AI providers. The orchestrator ({}) delegated this task to you. You share its workspace and files but not its conversation. \
Do the task completely without asking questions: where something is ambiguous, make a reasonable choice and say so. \
End with a short report as your final message: what you did, the files you created or changed (paths), and anything the orchestrator should check.\n\nTask:\n",
            orchestrator.label()
        ));
    }
    prompt.push_str(&cap(task, TASK_CHARS));
    let files: Vec<&str> = files.iter().map(|file| file.trim()).filter(|file| !file.is_empty()).take(50).collect();
    if !files.is_empty() {
        prompt.push_str("\n\nFiles to start from:\n");
        for file in files {
            prompt.push_str("- ");
            prompt.push_str(file);
            prompt.push('\n');
        }
    }
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_worker_is_told_the_task_stands_alone_and_its_last_message_is_the_report() {
        let prompt = worker_prompt("Draw the app icon", &["assets/".into(), " ".into()], Provider::Claude, false);
        assert!(prompt.contains("orchestrator (Claude Code)"));
        assert!(prompt.contains("final message"));
        assert!(prompt.ends_with("Files to start from:\n- assets/\n"));
        let follow = worker_prompt("Make it blue", &[], Provider::Codex, true);
        assert!(follow.starts_with("Follow-up"));
        assert!(!follow.contains("worker on a team in ThingMaker"));
    }

    #[test]
    fn a_refusal_reads_as_a_rate_limit_in_either_providers_words() {
        assert!(looks_rate_limited("rate_limit: You've hit your usage limit. Try again in 2 hours."));
        assert!(looks_rate_limited("Claude AI usage limit reached|1790785099"));
        assert!(looks_rate_limited("You've hit your session limit"));
        assert!(!looks_rate_limited("the tests failed"));
    }
}
