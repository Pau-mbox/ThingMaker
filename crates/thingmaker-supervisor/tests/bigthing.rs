//! Big Thing end to end: the engine drives a mock Claude Code orchestrator
//! through a whole goal — briefing, continuations, checks read out of the
//! turn's own tool results, completion — and through the ways a run stalls:
//! a spent account, a session that is not open, a plan asked of a document.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{Value, json};
use thingmaker_supervisor::{
    DesktopError,
    acp::LaunchTarget,
    agents::{PermissionStance, Provider, claude::launch::ClaudeLaunchOptions, events::QuotaSnapshot},
    delegation::{Caller, Combo, Delegation, TeamExtension, WorkerLauncher, WorkerSpec, jobs::BoxFuture},
    storage::{
        Storage,
        odyssey::{CheckKind, CheckSource, JournalKind, MilestoneState, NewOdyssey, OdysseyState},
        workspaces::SessionOrigin,
    },
    bigthing::{Engine, EngineEvent, EngineHost, LiveSession, OpenSpec},
    supervisor::{AgentLaunch, SessionActor, SessionActorConfig},
};

fn python() -> Option<PathBuf> {
    for candidate in ["python3", "python"] {
        if let Ok(output) = std::process::Command::new(candidate).arg("--version").output()
            && output.status.success()
        {
            return Some(PathBuf::from(candidate));
        }
    }
    None
}

fn fixture(name: &str) -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/test-fixtures/acp").join(name).canonicalize().unwrap().to_string_lossy().into_owned()
}

/// Opens mock Claude sessions the way the host opens real ones.
struct MockHost {
    python: PathBuf,
    flags: Vec<String>,
    storage: Arc<Mutex<Storage>>,
    root: PathBuf,
    workspace_id: String,
    sessions: Mutex<HashMap<String, LiveSession>>,
    events: Mutex<Vec<EngineEvent>>,
    opened: Mutex<Vec<OpenSpec>>,
    delegation: Option<Delegation>,
}

impl MockHost {
    async fn launch(&self, resume: Option<String>, combo: Option<Combo>) -> Result<LiveSession, DesktopError> {
        let mut prefix = vec![fixture("mock-claude-acp.py")];
        prefix.extend(self.flags.iter().cloned());
        let mut options = ClaudeLaunchOptions::new(&self.root, self.python.clone(), prefix);
        options.permission_mode = PermissionStance::AcceptEdits;
        options.resume = resume;
        let mut config = SessionActorConfig::new(LaunchTarget::executable(self.python.clone()), AgentLaunch::Claude(options));
        config.timeouts.turn = Duration::from_secs(20);
        config.timeouts.control = Duration::from_secs(5);
        config.timeouts.shutdown = Duration::from_secs(5);
        let actor = SessionActor::open(config).await?;
        let snapshot = actor.snapshot().await?;
        let agent_session_id = snapshot.agent_session_id.clone().unwrap();
        let row = self.storage.lock().unwrap().session_upsert(&self.workspace_id, &agent_session_id, SessionOrigin::Desktop, Provider::Claude).unwrap();
        let handle = actor.handle().id.clone();
        if let Some(delegation) = &self.delegation {
            delegation.register(&handle, Provider::Claude, self.root.clone(), combo.unwrap_or_default());
        }
        let live = LiveSession { actor, handle, agent_session_id, row_id: row.id.clone(), workspace_id: self.workspace_id.clone(), provider: Provider::Claude, root: self.root.clone(), model: Some("opus".into()) };
        self.sessions.lock().unwrap().insert(row.id, live.clone());
        Ok(live)
    }
}

struct Host(Arc<MockHost>);

impl EngineHost for Host {
    fn live(&self, row_id: &str) -> Option<LiveSession> {
        self.0.sessions.lock().unwrap().get(row_id).cloned()
    }
    fn live_handle(&self, handle: &str) -> Option<LiveSession> {
        self.0.sessions.lock().unwrap().values().find(|live| live.handle == handle).cloned()
    }
    fn open(&self, spec: OpenSpec) -> BoxFuture<Result<LiveSession, DesktopError>> {
        self.0.opened.lock().unwrap().push(spec.clone());
        let host = self.0.clone();
        Box::pin(async move { host.launch(spec.resume, spec.combo).await })
    }
    fn quota(&self, _provider: Provider) -> BoxFuture<Option<QuotaSnapshot>> {
        Box::pin(async { None })
    }
    fn session_tokens(&self, _session: &LiveSession) -> Option<i64> {
        None
    }
    fn install_skill(&self) -> bool {
        false
    }
    fn install_delegate(&self, _root: &Path) -> bool {
        false
    }
    fn usable_providers(&self) -> Vec<Provider> {
        vec![Provider::Claude]
    }
    fn emit(&self, event: EngineEvent) {
        self.0.events.lock().unwrap().push(event);
    }
}

/// Opens mock workers: Codex for Codex slots, Claude for Claude ones.
struct Workers {
    python: PathBuf,
    launched: Mutex<Vec<WorkerSpec>>,
}

impl WorkerLauncher for Workers {
    fn launch(&self, spec: WorkerSpec) -> BoxFuture<Result<SessionActor, DesktopError>> {
        self.launched.lock().unwrap().push(spec.clone());
        let python = self.python.clone();
        let (target, launch) = match spec.slot.provider {
            Provider::Codex => {
                let mut options = thingmaker_supervisor::agents::codex::CodexLaunchOptions::new(&spec.root, python.clone());
                options.permission_mode = PermissionStance::AcceptEdits;
                (LaunchTarget { executable: python, prefix_args: vec![fixture("mock-codex-app-server.py")] }, AgentLaunch::Codex(options))
            }
            _ => {
                let mut options = ClaudeLaunchOptions::new(&spec.root, python.clone(), vec![fixture("mock-claude-acp.py")]);
                options.permission_mode = PermissionStance::AcceptEdits;
                (LaunchTarget::executable(python), AgentLaunch::Claude(options))
            }
        };
        Box::pin(async move {
            let mut config = SessionActorConfig::new(target, launch);
            config.timeouts.turn = Duration::from_secs(20);
            config.timeouts.control = Duration::from_secs(5);
            config.timeouts.shutdown = Duration::from_secs(5);
            SessionActor::open(config).await
        })
    }
    fn released(&self, _worker_handle: &str) {}
}

struct Fixture {
    _temp: tempfile::TempDir,
    host: Arc<MockHost>,
    engine: Engine,
    storage: Arc<Mutex<Storage>>,
    delegation: Delegation,
}

fn fixture_with(flags: &[&str]) -> Option<Fixture> {
    let python = python()?;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("repo").canonicalize().unwrap_or_else(|_| {
        std::fs::create_dir_all(temp.path().join("repo")).unwrap();
        temp.path().join("repo").canonicalize().unwrap()
    });
    let storage = Arc::new(Mutex::new(Storage::open(&temp.path().join("t.db")).unwrap()));
    let workspace = storage.lock().unwrap().workspace_upsert(&root.to_string_lossy(), &root.to_string_lossy(), "w-test").unwrap();
    let workers = Arc::new(Workers { python: python.clone(), launched: Mutex::default() });
    let jobs: Arc<Mutex<Option<Engine>>> = Arc::new(Mutex::new(None));
    let heard = jobs.clone();
    let delegation = Delegation::new(workers, move |job| {
        if let Some(engine) = heard.lock().unwrap().as_ref() {
            engine.note_job(job);
        }
    });
    let host = Arc::new(MockHost {
        python,
        flags: flags.iter().map(|flag| flag.to_string()).collect(),
        storage: storage.clone(),
        root,
        workspace_id: workspace.id,
        sessions: Mutex::default(),
        events: Mutex::default(),
        opened: Mutex::default(),
        delegation: Some(delegation.clone()),
    });
    let engine = Engine::new(storage.clone(), Arc::new(Host(host.clone())), Some(delegation.clone()), temp.path().join("data"));
    delegation.set_extension(Arc::new(engine.clone()));
    *jobs.lock().unwrap() = Some(engine.clone());
    engine.start(Duration::from_millis(500));
    Some(Fixture { _temp: temp, host, engine, storage, delegation })
}

impl Fixture {
    /// A goal on a freshly opened session, with milestones whose check is
    /// `true`, so a turn that runs it verifies it.
    async fn goal(&self, milestones: usize) -> (String, LiveSession) {
        self.goal_with(milestones, None).await
    }

    async fn goal_with(&self, milestones: usize, combo: Option<Combo>) -> (String, LiveSession) {
        let live = self.host.launch(None, combo).await.unwrap();
        let storage = self.storage.lock().unwrap();
        let goal = storage
            .odyssey_create(&NewOdyssey { workspace_id: self.host.workspace_id.clone(), session_id: Some(live.row_id.clone()), title: "Write two files".into(), max_continuations: 20, ..Default::default() })
            .unwrap();
        for index in 0..milestones {
            storage.milestone_add(&goal.id, &format!("Write file {}", index + 1), "", CheckKind::Command, Some("true"), None).unwrap();
        }
        (goal.id, live)
    }

    async fn until(&self, goal_id: &str, what: &str, seconds: u64, done: impl Fn(&thingmaker_supervisor::storage::odyssey::OdysseyView) -> bool) -> thingmaker_supervisor::storage::odyssey::OdysseyView {
        let deadline = std::time::Instant::now() + Duration::from_secs(seconds);
        loop {
            let view = self.storage.lock().unwrap().odyssey_view(goal_id).unwrap().unwrap();
            if done(&view) {
                return view;
            }
            if std::time::Instant::now() > deadline {
                let journal: Vec<String> = view.journal.iter().map(|entry| format!("{:?}: {}", entry.kind, entry.summary)).collect();
                panic!("timed out waiting for {what}; state {:?}, runtime {:?}\n{}", view.goal.state, self.engine.runtime(goal_id), journal.join("\n"));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_goal_runs_from_its_briefing_to_complete_with_every_milestone_verified() {
    let Some(fixture) = fixture_with(&["--follow-plan"]) else { return };
    let (goal_id, live) = fixture.goal(2).await;
    fixture.engine.start_goal(&goal_id).await.unwrap();
    let view = fixture.until(&goal_id, "the goal to complete", 60, |view| view.goal.state == OdysseyState::Complete).await;

    assert!(view.milestones.iter().all(|milestone| milestone.state == MilestoneState::Verified), "{:?}", view.milestones.iter().map(|m| m.state).collect::<Vec<_>>());
    assert!(view.milestones.iter().all(|milestone| milestone.check_source == Some(CheckSource::AgentToolResult)), "verified from the turn's own tool results");
    let kinds: Vec<JournalKind> = view.journal.iter().map(|entry| entry.kind).collect();
    assert_eq!(kinds.iter().filter(|kind| **kind == JournalKind::Briefing).count(), 1, "briefed once");
    assert_eq!(kinds.iter().filter(|kind| **kind == JournalKind::Continuation).count(), 2, "one continuation per milestone");
    let briefing = view.journal.iter().find(|entry| entry.kind == JournalKind::Briefing).unwrap();
    assert_eq!(briefing.provider.as_deref(), Some("claude"), "the timeline knows who was prompted");
    assert_eq!(briefing.model.as_deref(), Some("opus"));
    assert!(view.journal.iter().any(|entry| entry.summary == "Every milestone is verified or skipped"));
    assert_eq!(view.goal.continuations_used, 3, "briefing and two continuations, each answered");
    // The mock wrote a file per turn, so the no-progress guard never tripped.
    assert!(std::fs::read_dir(&live.root).unwrap().count() >= 2);
    assert!(fixture.host.events.lock().unwrap().iter().any(|event| matches!(event, EngineEvent::Notify { attention: "done", .. })));
    let row = fixture.storage.lock().unwrap().session_get(&live.row_id).unwrap().unwrap();
    assert_eq!(row.title_overlay.as_deref(), Some("Write two files"), "the session is named after the goal, not its first prompt");
    assert!(fixture.host.events.lock().unwrap().iter().any(|event| matches!(event, EngineEvent::SessionNamed { .. })));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_spent_account_parks_the_run_with_its_reset_time_instead_of_blocking_it() {
    let Some(fixture) = fixture_with(&["--limit"]) else { return };
    let (goal_id, _live) = fixture.goal(1).await;
    fixture.engine.start_goal(&goal_id).await.unwrap();
    let view = fixture.until(&goal_id, "the goal to park", 30, |view| view.goal.state == OdysseyState::WaitingUsage).await;
    let wait = view.journal.iter().find(|entry| entry.kind == JournalKind::Wait).unwrap();
    assert!(wait.summary.starts_with("Waiting for usage: the 5-hour window is at 100%"), "{}", wait.summary);
    assert!(wait.detail.as_deref().unwrap().contains("resume at"), "the refusal named its reset");
    assert!(fixture.engine.runtime(&goal_id).resume_at.is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_running_goal_whose_session_is_not_open_reopens_it_and_carries_on() {
    let Some(fixture) = fixture_with(&["--follow-plan"]) else { return };
    let (goal_id, live) = fixture.goal(1).await;
    // The app restarted: the session is in the record, not open.
    fixture.host.sessions.lock().unwrap().clear();
    let _ = live.actor.stop().await;
    fixture.storage.lock().unwrap().odyssey_set_state(&goal_id, OdysseyState::Running).unwrap();
    let view = fixture.until(&goal_id, "the goal to complete", 60, |view| view.goal.state == OdysseyState::Complete).await;
    let opened = fixture.host.opened.lock().unwrap().clone();
    assert_eq!(opened.len(), 1);
    assert_eq!(opened[0].resume.as_deref(), Some(live.agent_session_id.as_str()), "resumed, not replaced");
    assert!(view.journal.iter().any(|entry| entry.summary == "Reopened the run's session"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_plan_is_asked_of_a_document_and_waits_for_the_user_to_start_it() {
    let Some(fixture) = fixture_with(&["--follow-plan"]) else { return };
    let (goal_id, _live) = fixture.goal(0).await;
    fixture.storage.lock().unwrap().odyssey_set_plan(&goal_id, Some("roadmap.md"), Some("# Roadmap\n\nWrite two files."), None).unwrap();
    fixture.engine.request_plan(&goal_id).await.unwrap();
    let view = fixture.until(&goal_id, "the plan", 30, |view| view.milestones.len() == 2).await;
    assert_eq!(view.goal.state, OdysseyState::Draft, "a plan out of a document is the user's to start");
    assert_eq!(view.milestones[0].check_spec.as_deref(), Some("true"));
    assert!(view.journal.iter().any(|entry| entry.summary.starts_with("The agent proposed 2 milestones from roadmap.md")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_protocol_tools_answer_from_the_record_and_the_memory_is_shared() {
    let Some(fixture) = fixture_with(&["--follow-plan"]) else { return };
    let (goal_id, live) = fixture.goal(2).await;
    let caller = Caller::Orchestrator { session: live.handle.clone(), provider: Provider::Claude, root: live.root.clone() };
    let call = |name: &str, arguments: Value| {
        let engine = fixture.engine.clone();
        let caller = caller.clone();
        let name = name.to_string();
        async move { engine.call(&caller, &name, &arguments).expect("an engine tool").await }
    };
    let names: Vec<String> = fixture.engine.tools(&caller).iter().map(|tool| tool["name"].as_str().unwrap().to_string()).collect();
    assert!(names.contains(&"bigthing_report".to_string()) && names.contains(&"memory_write".to_string()));
    let worker = Caller::Worker { orchestrator: live.handle.clone(), provider: Provider::Codex, root: live.root.clone(), name: "luna".into(), job_id: "job-1".into() };
    let worker_tools: Vec<String> = fixture.engine.tools(&worker).iter().map(|tool| tool["name"].as_str().unwrap().to_string()).collect();
    assert_eq!(worker_tools, ["memory_read", "memory_write", "board"]);

    // Validated on the spot.
    let wrong = call("bigthing_report", json!({"milestone": 9, "status": "complete"})).await;
    assert_eq!(wrong["isError"], true);
    assert!(wrong["content"][0]["text"].as_str().unwrap().contains("the plan has 2"));
    let task = call("bigthing_task", json!({"milestone": 1, "task": 1, "status": "done"})).await;
    assert_eq!(task["isError"], true, "milestone 1 has no tasks");

    // The memory, written by the orchestrator and read by a worker.
    let written = call("memory_write", json!({"kind": "decision", "title": "Files are plain text", "body": "No markdown."})).await;
    assert_eq!(written["isError"], false, "{written}");
    let read = fixture.engine.call(&worker, "memory_read", &json!({"query": "plain"})).unwrap().await;
    assert_eq!(read["structuredContent"]["entries"][0]["title"], "Files are plain text");
    assert_eq!(read["structuredContent"]["entries"][0]["author"], "claude · orchestrator");
    let board = fixture.engine.call(&worker, "board", &json!({})).unwrap().await;
    assert_eq!(board["structuredContent"]["milestones"].as_array().unwrap().len(), 2);

    // A report through the tool is accepted and described.
    let ok = call("bigthing_report", json!({"milestone": 1, "status": "complete", "note": "wrote it"})).await;
    assert_eq!(ok["isError"], false);
    assert!(ok["structuredContent"]["note"].as_str().unwrap().contains("verified by its check: `true` must exit 0"), "{ok}");
    // Recorded the moment it is made, not when the turn ends, and a second
    // milestone in the same turn does not replace the first.
    let second = call("bigthing_report", json!({"milestone": 2, "status": "complete", "note": "both done"})).await;
    assert_eq!(second["isError"], false);
    let view = fixture.storage.lock().unwrap().odyssey_view(&goal_id).unwrap().unwrap();
    assert_eq!(view.milestones.iter().map(|milestone| milestone.state).collect::<Vec<_>>(), [MilestoneState::Reported, MilestoneState::Reported]);
    assert_eq!(view.journal.iter().filter(|entry| entry.kind == JournalKind::Report).count(), 2);
    // A plan is only for a goal that has none; a running one amends.
    let plan = call("bigthing_propose_plan", json!({"milestones": [{"title": "x"}]})).await;
    assert_eq!(plan["isError"], false, "the goal is still a draft: {plan}");
    fixture.storage.lock().unwrap().odyssey_set_state(&goal_id, OdysseyState::Running).unwrap();
    let late = call("bigthing_propose_plan", json!({"milestones": [{"title": "x"}]})).await;
    assert_eq!(late["isError"], true);
    let amend = call("bigthing_amend", json!({"ops": [{"op": "drop", "target": 2}], "reason": "not needed"})).await;
    assert!(amend["structuredContent"]["diff"].as_str().unwrap().contains("− Drop milestone 2 \"Write file 2\" (not needed)"), "{amend}");
    assert!(fixture.delegation.combo(&live.handle).is_some(), "the session leads a team, so it has the tools");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn the_runner_hands_ready_tasks_to_workers_in_parallel_and_has_them_reviewed() {
    use thingmaker_supervisor::delegation::WorkerSlot;
    use thingmaker_supervisor::storage::odyssey::{Dispatch, GoalEdit, StepState};
    let Some(fixture) = fixture_with(&["--follow-plan"]) else { return };
    let team = Combo {
        workers: vec![
            WorkerSlot { name: "luna".into(), provider: Provider::Codex, model: Some("gpt-6-luna".into()), effort: None, capabilities: vec!["code".into()], note: None },
            WorkerSlot { name: "sonnet".into(), provider: Provider::Claude, model: None, effort: None, capabilities: vec!["review".into()], note: None },
        ],
        native_subagents: false,
    };
    let (goal_id, _live) = fixture.goal_with(1, Some(team)).await;
    {
        let storage = fixture.storage.lock().unwrap();
        storage.odyssey_edit_goal(&goal_id, &GoalEdit { dispatch: Some(Dispatch::Runner), review_tasks: Some(true), ..GoalEdit::default() }).unwrap();
        let milestone = storage.odyssey_view(&goal_id).unwrap().unwrap().milestones[0].id.clone();
        storage.step_add_with(&milestone, "Write the parser", "", &[], Some("code")).unwrap();
        storage.step_add_with(&milestone, "Write the tests", "", &[], Some("code")).unwrap();
    }
    fixture.engine.start_goal(&goal_id).await.unwrap();
    let view = fixture.until(&goal_id, "the goal to complete", 90, |view| view.goal.state == OdysseyState::Complete).await;
    let steps = &view.milestones[0].steps;
    assert!(steps.iter().all(|step| step.state == StepState::Done), "{:?}", steps.iter().map(|step| (step.state, step.note.clone())).collect::<Vec<_>>());
    assert!(steps.iter().all(|step| step.harness.as_deref() == Some("team · Codex")), "both went to the Codex worker");
    assert!(steps.iter().all(|step| step.review.as_deref().is_some_and(|review| review.contains("sonnet"))), "reviewed on the other provider: {:?}", steps.iter().map(|step| step.review.clone()).collect::<Vec<_>>());
    assert_eq!(steps[0].agent_name.as_deref(), Some("1.1-write-the-parser"));
    let journal: Vec<&str> = view.journal.iter().map(|entry| entry.summary.as_str()).collect();
    assert!(journal.iter().any(|summary| summary.starts_with("Gave task 1.1 to luna")));
    assert!(journal.iter().any(|summary| summary.starts_with("Gave task 1.2 to luna")));
    // The orchestrator heard about the tasks in one continuation.
    let continuation = view.journal.iter().find(|entry| entry.kind == JournalKind::Continuation).unwrap();
    assert!(continuation.detail.as_deref().unwrap().contains("The workers finished their tasks"), "{}", continuation.detail.as_deref().unwrap());
    assert_eq!(view.milestones[0].state, MilestoneState::Verified);
}
