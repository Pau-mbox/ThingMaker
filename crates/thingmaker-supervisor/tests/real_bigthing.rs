//! Big Thing end to end on the real providers, on the user's own plans: a
//! two-milestone goal in a scratch Git repository, run by the engine on a
//! Claude orchestrator and on a Codex one, each leading a team so it has the
//! `bigthing_*` tools. Spends a handful of small turns, so it only runs when
//! asked:
//!
//! ```text
//! THINGMAKER_REAL_BIGTHING=1 cargo test -p thingmaker-supervisor --test real_bigthing -- --nocapture --test-threads=1
//! ```
//!
//! What it proves that the mocks cannot: a real model follows the briefing,
//! reports through the tools (or the lines), its milestones are verified by
//! checks, and the run reaches `complete` without a human.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use thingmaker_supervisor::{
    DesktopError,
    acp::LaunchTarget,
    agents::{PermissionStance, Provider, claude::launch::{ClaudeLaunchOptions, locate_adapter}, codex::CodexLaunchOptions, events::QuotaSnapshot},
    delegation::{Delegation, WorkerLauncher, WorkerSpec, jobs::BoxFuture, orchestrator_guidance, socket::{DelegationSocket, server_entry}},
    storage::{
        Storage,
        odyssey::{CheckKind, GoalEdit, JournalKind, MilestoneState, NewOdyssey, OdysseyState, Orchestrator},
        workspaces::SessionOrigin,
    },
    bigthing::{Engine, EngineEvent, EngineHost, LiveSession, OpenSpec},
    supervisor::{AgentLaunch, SessionActor, SessionActorConfig},
};

fn codex() -> PathBuf {
    std::env::var_os("THINGMAKER_CODEX").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"))
}

struct NoWorkers;

impl WorkerLauncher for NoWorkers {
    fn launch(&self, _spec: WorkerSpec) -> BoxFuture<Result<SessionActor, DesktopError>> {
        Box::pin(async { Err(DesktopError::not_ready("this test has no workers")) })
    }
    fn released(&self, _worker_handle: &str) {}
}

struct RealHost {
    provider: Provider,
    storage: Arc<Mutex<Storage>>,
    root: PathBuf,
    workspace_id: String,
    delegation: Delegation,
    socket: PathBuf,
    sessions: Mutex<HashMap<String, LiveSession>>,
}

impl RealHost {
    async fn launch(&self) -> Result<LiveSession, DesktopError> {
        let (target, mut agent) = match self.provider {
            Provider::Claude => {
                let home = PathBuf::from(std::env::var("HOME").unwrap());
                let (node, script) = locate_adapter(&home, None, std::env::var("THINGMAKER_CLAUDE_ACP").ok()).expect("claude-agent-acp is installed");
                let mut options = ClaudeLaunchOptions::new(&self.root, node.clone(), vec![script.to_string_lossy().into_owned()]);
                options.model = Some(std::env::var("THINGMAKER_REAL_CLAUDE_MODEL").unwrap_or_else(|_| "sonnet".into()));
                options.effort = Some("low".into());
                options.permission_mode = PermissionStance::AcceptEdits;
                (LaunchTarget::executable(node), AgentLaunch::Claude(options))
            }
            _ => {
                let mut options = CodexLaunchOptions::new(&self.root, codex());
                options.model = Some(std::env::var("THINGMAKER_REAL_CODEX_MODEL").unwrap_or_else(|_| "gpt-6-luna".into()));
                options.effort = Some("low".into());
                options.permission_mode = PermissionStance::AcceptEdits;
                (LaunchTarget::executable(codex()), AgentLaunch::Codex(options))
            }
        };
        let key = agent.session_id();
        let token = self.delegation.register(&key, self.provider, self.root.clone(), Default::default());
        let mut config = SessionActorConfig::new(target, agent.clone());
        config.mcp_servers = vec![server_entry(&PathBuf::from(env!("CARGO_BIN_EXE_thingmaker-mcp")), &[], &self.socket, &token)];
        match &mut agent {
            AgentLaunch::Claude(options) => {
                options.append_system_prompt = Some(orchestrator_guidance(false));
                config.environment = config.environment.clone().with_set("MCP_TOOL_TIMEOUT", "1800000");
            }
            AgentLaunch::Codex(options) => options.developer_instructions = Some(orchestrator_guidance(false)),
            AgentLaunch::Gemini(_) => unreachable!(),
        }
        config.launch = agent;
        let actor = SessionActor::open(config).await?;
        let snapshot = actor.snapshot().await?;
        let agent_session_id = snapshot.agent_session_id.clone().unwrap();
        let row = self.storage.lock().unwrap().session_upsert(&self.workspace_id, &agent_session_id, SessionOrigin::Desktop, self.provider).unwrap();
        let live = LiveSession { actor: actor.clone(), handle: actor.handle().id.clone(), agent_session_id, row_id: row.id.clone(), workspace_id: self.workspace_id.clone(), provider: self.provider, root: self.root.clone(), model: None };
        self.sessions.lock().unwrap().insert(row.id, live.clone());
        Ok(live)
    }
}

struct Host(Arc<RealHost>);

impl EngineHost for Host {
    fn live(&self, row_id: &str) -> Option<LiveSession> {
        self.0.sessions.lock().unwrap().get(row_id).cloned()
    }
    fn live_handle(&self, handle: &str) -> Option<LiveSession> {
        self.0.sessions.lock().unwrap().values().find(|live| live.handle == handle).cloned()
    }
    fn open(&self, _spec: OpenSpec) -> BoxFuture<Result<LiveSession, DesktopError>> {
        let host = self.0.clone();
        Box::pin(async move { host.launch().await })
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
        vec![self.0.provider]
    }
    fn emit(&self, event: EngineEvent) {
        if let EngineEvent::Announce { text, .. } | EngineEvent::Notify { text, .. } = &event {
            eprintln!("· {text}");
        }
    }
}

async fn run(provider: Provider) {
    let scratch = tempfile::tempdir().unwrap();
    let root = scratch.path().join("repo");
    std::fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let git = |args: &[&str]| assert!(std::process::Command::new("git").arg("-C").arg(&root).args(args).status().unwrap().success());
    git(&["init", "-q", "-b", "main"]);
    std::fs::write(root.join("README.md"), "# Scratch\n").unwrap();
    git(&["add", "-A"]);
    git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);

    let storage = Arc::new(Mutex::new(Storage::open(&scratch.path().join("t.db")).unwrap()));
    let workspace = storage.lock().unwrap().workspace_upsert(&root.to_string_lossy(), &root.to_string_lossy(), "w-real").unwrap();
    let delegation = Delegation::new(Arc::new(NoWorkers), |_| {});
    let socket = DelegationSocket::bind(delegation.clone(), scratch.path().join("mcp.sock")).unwrap();
    let host = Arc::new(RealHost { provider, storage: storage.clone(), root: root.clone(), workspace_id: workspace.id.clone(), delegation: delegation.clone(), socket: socket.path().to_path_buf(), sessions: Mutex::default() });
    let engine = Engine::new(storage.clone(), Arc::new(Host(host.clone())), Some(delegation.clone()), scratch.path().join("data"));
    delegation.set_extension(Arc::new(engine.clone()));
    engine.start(Duration::from_secs(2));

    let live = host.launch().await.expect("orchestrator attached");
    let goal = {
        let storage = storage.lock().unwrap();
        let goal = storage
            .odyssey_create(&NewOdyssey {
                workspace_id: workspace.id.clone(),
                session_id: Some(live.row_id.clone()),
                title: "Write two greeting files".into(),
                brief: "A two-milestone test of Big Thing. Keep every turn short; do not explore the repository.".into(),
                max_continuations: 10,
                ..Default::default()
            })
            .unwrap();
        let pin = if provider == Provider::Codex { Orchestrator::Codex } else { Orchestrator::Claude };
        storage.odyssey_edit_goal(&goal.id, &GoalEdit { orchestrator: Some(pin), ..GoalEdit::default() }).unwrap();
        storage.milestone_add(&goal.id, "Create hello.txt", "Create hello.txt in the repository root containing the single word hello.", CheckKind::Command, Some("test -f hello.txt"), None).unwrap();
        storage.milestone_add(&goal.id, "Create world.txt", "Create world.txt in the repository root containing the single word world.", CheckKind::Command, Some("test -f world.txt"), None).unwrap();
        goal
    };
    engine.start_goal(&goal.id).await.expect("started");

    let deadline = std::time::Instant::now() + Duration::from_secs(900);
    let view = loop {
        let view = storage.lock().unwrap().odyssey_view(&goal.id).unwrap().unwrap();
        if matches!(view.goal.state, OdysseyState::Complete | OdysseyState::Blocked | OdysseyState::Paused) {
            break view;
        }
        assert!(std::time::Instant::now() < deadline, "no end within 15 minutes; state {:?}, runtime {:?}", view.goal.state, engine.runtime(&goal.id));
        tokio::time::sleep(Duration::from_secs(3)).await;
    };
    for entry in view.journal.iter().rev() {
        eprintln!("{:?}: {}", entry.kind, entry.summary);
    }
    let calls = live.actor.snapshot().await.map(|snapshot| snapshot.tool_calls).unwrap_or_default();
    for patch in calls.values() {
        eprintln!("tool call: {:?} {:?}", patch.title, patch.raw_input.as_ref().map(|input| input.to_string().chars().take(120).collect::<String>()));
    }
    let via_tools = calls.values().filter(|patch| patch.title.as_deref().unwrap_or("").contains("bigthing_report") || patch.raw_input.as_ref().is_some_and(|input| input.to_string().contains("bigthing_report"))).count();
    eprintln!("{} reported through the tools {via_tools} time(s)", provider.label());
    assert_eq!(view.goal.state, OdysseyState::Complete, "{provider:?}: {:?}", engine.runtime(&goal.id));
    assert!(view.milestones.iter().all(|milestone| milestone.state == MilestoneState::Verified));
    assert!(root.join("hello.txt").exists() && root.join("world.txt").exists());
    assert!(view.journal.iter().any(|entry| entry.kind == JournalKind::Briefing));
    assert!(!view.journal.iter().any(|entry| entry.summary.starts_with("Moving to")), "the run stayed on the provider it is pinned to");
    delegation.release(&live.handle).await;
    let _ = live.actor.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_goal_runs_to_complete_on_claude() {
    if std::env::var("THINGMAKER_REAL_BIGTHING").as_deref() != Ok("1") {
        eprintln!("set THINGMAKER_REAL_BIGTHING=1 to spend real turns; skipping");
        return;
    }
    run(Provider::Claude).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_goal_runs_to_complete_on_codex() {
    if std::env::var("THINGMAKER_REAL_BIGTHING").as_deref() != Ok("1") {
        eprintln!("set THINGMAKER_REAL_BIGTHING=1 to spend real turns; skipping");
        return;
    }
    run(Provider::Codex).await;
}
