//! The Gemini bridge against the real `agy`, on the user's own Google
//! account. A few small turns, so it only runs when asked:
//!
//! ```text
//! THINGMAKER_REAL_GEMINI=1 cargo test -p thingmaker-supervisor --test real_gemini -- --nocapture --test-threads=1
//! ```
//!
//! Read-only (`--mode plan`) in a scratch directory: the turns need no tools.
//! `THINGMAKER_AGY` names the binary; otherwise `~/.local/bin/agy`.

use std::{path::PathBuf, sync::Arc, time::Duration};

use thingmaker_supervisor::{
    DesktopError,
    acp::{LaunchTarget, SessionUpdate, updates::ContentBlock},
    agents::{PermissionStance, Provider, claude::launch::{ClaudeLaunchOptions, locate_adapter}, gemini::GeminiLaunchOptions},
    delegation::{Combo, Delegation, JobStatus, WorkerLauncher, WorkerSlot, WorkerSpec, jobs::BoxFuture, orchestrator_guidance, socket::{DelegationSocket, server_entry}},
    supervisor::{AgentLaunch, SessionActor, SessionActorConfig, SessionEvent, TurnEffect, TurnPhase},
};

const MODEL: &str = "gemini-3.8-flash-low";

fn agy() -> PathBuf {
    std::env::var_os("THINGMAKER_AGY").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap()).join(".local/bin/agy"))
}

fn enabled() -> bool {
    if std::env::var("THINGMAKER_REAL_GEMINI").as_deref() != Ok("1") {
        eprintln!("set THINGMAKER_REAL_GEMINI=1 to spend real turns; skipping");
        return false;
    }
    true
}

fn gemini(root: &std::path::Path, resume: Option<String>) -> SessionActorConfig {
    let mut options = GeminiLaunchOptions::new(root, agy());
    options.model = Some(MODEL.into());
    options.permission_mode = PermissionStance::ReadOnly;
    options.resume = resume;
    SessionActorConfig::new(LaunchTarget::executable(agy()), AgentLaunch::Gemini(options))
}

async fn turn(actor: &SessionActor, text: &str) -> (TurnPhase, String) {
    let mut subscription = actor.subscribe();
    actor.submit_text(format!("r-{}", text.len()), text).await.expect("submitted");
    let mut reply = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let Ok(Some(event)) = tokio::time::timeout(remaining, subscription.recv()).await else { panic!("no settle; reply {reply:?}") };
        match &event.payload {
            SessionEvent::Update(SessionUpdate::AgentMessage(message)) => {
                reply.extend(message.content.iter().filter_map(|block| if let ContentBlock::Text { text } = block { Some(text.as_str()) } else { None }));
            }
            SessionEvent::Diagnostic { text } => eprintln!("diagnostic: {}", text.chars().take(200).collect::<String>()),
            SessionEvent::Turn(TurnEffect::Settled { phase, error, .. }) => {
                eprintln!("settled {phase:?} {error:?}");
                return (*phase, reply);
            }
            _ => {}
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_gemini_session_answers_and_resumes() {
    if !enabled() {
        return;
    }
    let scratch = tempfile::tempdir().unwrap();
    let actor = SessionActor::open(gemini(scratch.path(), None)).await.expect("attached");
    let snapshot = actor.snapshot().await.unwrap();
    let conversation = snapshot.agent_session_id.clone().expect("agy named its conversation");
    eprintln!("conversation {conversation} · options {}", snapshot.config_options);
    assert_eq!(snapshot.provider, Provider::Gemini);
    let (phase, reply) = turn(&actor, "Reply with exactly the word ALPHA and nothing else.").await;
    assert_eq!(phase, TurnPhase::Succeeded);
    assert!(reply.to_ascii_uppercase().contains("ALPHA"), "{reply:?}");
    let _ = actor.stop().await;

    let resumed = SessionActor::open(gemini(scratch.path(), Some(conversation.clone()))).await.expect("resumed");
    assert_eq!(resumed.snapshot().await.unwrap().agent_session_id.as_deref(), Some(conversation.as_str()));
    let (phase, reply) = turn(&resumed, "What single word did you reply with before? Reply with just that word.").await;
    assert_eq!(phase, TurnPhase::Succeeded);
    assert!(reply.to_ascii_uppercase().contains("ALPHA"), "the context survived the resume: {reply:?}");
    let _ = resumed.stop().await;
}

struct Launcher;

impl WorkerLauncher for Launcher {
    fn launch(&self, spec: WorkerSpec) -> BoxFuture<Result<SessionActor, DesktopError>> {
        let mut options = GeminiLaunchOptions::new(&spec.root, agy());
        options.model = spec.slot.model.clone();
        options.permission_mode = PermissionStance::ReadOnly;
        Box::pin(async move { SessionActor::open(SessionActorConfig::new(LaunchTarget::executable(agy()), AgentLaunch::Gemini(options))).await })
    }
    fn released(&self, _worker_handle: &str) {}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_claude_orchestrator_delegates_to_a_gemini_worker() {
    if !enabled() {
        return;
    }
    let scratch = tempfile::tempdir().unwrap();
    let delegation = Delegation::new(Arc::new(Launcher), |job| eprintln!("job {} {:?} {:?}", job.id, job.status, job.error));
    let socket = DelegationSocket::bind(delegation.clone(), scratch.path().join("mcp.sock")).unwrap();
    let worker = WorkerSlot { name: "flash".into(), provider: Provider::Gemini, model: Some(MODEL.into()), effort: None, capabilities: vec!["fast".into()], note: None };
    let home = PathBuf::from(std::env::var("HOME").unwrap());
    let (node, script) = locate_adapter(&home, None, std::env::var("THINGMAKER_CLAUDE_ACP").ok()).expect("claude-agent-acp");
    let mut options = ClaudeLaunchOptions::new(scratch.path(), node.clone(), vec![script.to_string_lossy().into_owned()]);
    options.model = Some("sonnet".into());
    options.effort = Some("low".into());
    options.permission_mode = PermissionStance::AcceptEdits;
    options.disallowed_tools = vec!["Agent".into(), "Task".into()];
    options.append_system_prompt = Some(orchestrator_guidance(true));
    let agent = AgentLaunch::Claude(options);
    let key = agent.session_id();
    let token = delegation.register(&key, Provider::Claude, scratch.path().to_path_buf(), Combo { workers: vec![worker], native_subagents: false });
    let mut config = SessionActorConfig::new(LaunchTarget::executable(node), agent);
    config.mcp_servers = vec![server_entry(&PathBuf::from(env!("CARGO_BIN_EXE_thingmaker-mcp")), &[], socket.path(), &token)];
    config.environment = config.environment.clone().with_set("MCP_TOOL_TIMEOUT", "1800000");
    let actor = SessionActor::open(config).await.expect("orchestrator attached");
    let (phase, reply) = turn(
        &actor,
        "Test of the team tools. Delegate to the worker named flash the task: \"Reply with exactly the word PONG and nothing else.\" Then call await_jobs for that job and reply with the worker's report verbatim, nothing else.",
    )
    .await;
    let jobs = delegation.jobs(&key);
    eprintln!("orchestrator said {reply:?}\njobs {jobs:#?}");
    assert_eq!(phase, TurnPhase::Succeeded);
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].status, JobStatus::Succeeded);
    assert_eq!(jobs[0].provider, Provider::Gemini);
    assert!(jobs[0].result.as_deref().unwrap_or_default().to_ascii_uppercase().contains("PONG"));
    delegation.release(&key).await;
    let _ = actor.stop().await;
}

/// What a shell command's result looks like on `agy`'s stream, bridged: the
/// shape Super Thing reads a check's exit code from.
#[tokio::test]
async fn a_shell_commands_result_carries_what_a_check_needs() {
    if !enabled() {
        return;
    }
    let scratch = tempfile::tempdir().unwrap();
    let mut config = gemini(scratch.path(), None);
    if let AgentLaunch::Gemini(options) = &mut config.launch {
        options.permission_mode = PermissionStance::AcceptEdits;
    }
    let actor = SessionActor::open(config).await.expect("attached");
    let mut subscription = actor.subscribe();
    actor
        .submit_text("r1", "Run exactly these two shell commands, one tool call each, then reply OK: `echo pass-marker` and `sh -c 'echo fail-marker; exit 3'`.")
        .await
        .expect("submitted");
    loop {
        let event = tokio::time::timeout(Duration::from_secs(240), subscription.recv()).await.expect("settles").expect("stream");
        match &event.payload {
            SessionEvent::Update(SessionUpdate::ToolCall(patch)) | SessionEvent::Update(SessionUpdate::ToolCallUpdate(patch)) => {
                eprintln!("TOOL {} kind={:?} status={:?}\n  rawInput={}\n  rawOutput={}\n  content={}",
                    patch.tool_call_id.clone().unwrap_or_default(), patch.kind, patch.status,
                    serde_json::to_string(&patch.raw_input).unwrap_or_default(),
                    serde_json::to_string(&patch.raw_output).unwrap_or_default().chars().take(600).collect::<String>(),
                    serde_json::to_string(&patch.content).unwrap_or_default().chars().take(400).collect::<String>());
            }
            SessionEvent::Turn(TurnEffect::Settled { .. }) => break,
            _ => {}
        }
    }
    let _ = actor.stop().await;
}
