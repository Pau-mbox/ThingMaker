//! Delegation end to end: an orchestrator's MCP client talks to the relay,
//! the relay to the socket, and jobs run on worker sessions (the Claude and
//! Codex mocks) opened through a launcher like the host's.

use std::{
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use thingmaker_supervisor::{
    DesktopError,
    acp::LaunchTarget,
    agents::{PermissionStance, Provider, claude::launch::ClaudeLaunchOptions, codex::CodexLaunchOptions},
    delegation::{
        Combo, Delegation, JobStatus, JobView, WorkerLauncher, WorkerSlot, WorkerSpec,
        jobs::{BoxFuture, DelegateArgs, RetryPolicy},
        socket::{DelegationSocket, relay_to},
    },
    supervisor::{AgentLaunch, SessionActor, SessionActorConfig},
};
use serde_json::{Value, json};

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

/// Opens mock workers the way the host opens real ones.
struct MockLauncher {
    python: PathBuf,
    codex_flags: Vec<String>,
    launched: Mutex<Vec<WorkerSpec>>,
    released: Mutex<Vec<String>>,
}

impl WorkerLauncher for MockLauncher {
    fn launch(&self, spec: WorkerSpec) -> BoxFuture<Result<SessionActor, DesktopError>> {
        self.launched.lock().unwrap().push(spec.clone());
        let python = self.python.clone();
        let (target, launch) = match spec.slot.provider {
            Provider::Claude => {
                let mut options = ClaudeLaunchOptions::new(&spec.root, python.clone(), vec![fixture("mock-claude-acp.py")]);
                options.model = spec.slot.model.clone();
                options.permission_mode = PermissionStance::AcceptEdits;
                (LaunchTarget::executable(python), AgentLaunch::Claude(options))
            }
            Provider::Codex => {
                let mut options = CodexLaunchOptions::new(&spec.root, python.clone());
                options.model = spec.slot.model.clone();
                options.permission_mode = PermissionStance::AcceptEdits;
                let mut prefix = vec![fixture("mock-codex-app-server.py")];
                prefix.extend(self.codex_flags.iter().cloned());
                (LaunchTarget { executable: python, prefix_args: prefix }, AgentLaunch::Codex(options))
            }
            Provider::Gemini => {
                let mut options = thingmaker_supervisor::agents::gemini::GeminiLaunchOptions::new(&spec.root, python.clone());
                options.model = spec.slot.model.clone();
                options.permission_mode = PermissionStance::AcceptEdits;
                (LaunchTarget { executable: python, prefix_args: vec![fixture("mock-agy.py")] }, AgentLaunch::Gemini(options))
            }
        };
        Box::pin(async move {
            let mut config = SessionActorConfig::new(target, launch);
            config.timeouts.turn = Duration::from_secs(10);
            config.timeouts.control = Duration::from_secs(5);
            config.timeouts.shutdown = Duration::from_secs(5);
            SessionActor::open(config).await
        })
    }

    fn released(&self, worker_handle: &str) {
        self.released.lock().unwrap().push(worker_handle.to_string());
    }
}

fn team() -> Combo {
    Combo {
        workers: vec![
            WorkerSlot { name: "luna".into(), provider: Provider::Codex, model: Some("gpt-6-luna".into()), effort: Some("low".into()), capabilities: vec!["image".into(), "fast".into(), "code".into()], note: Some("images and quick edits".into()) },
            WorkerSlot { name: "sonnet".into(), provider: Provider::Claude, model: Some("sonnet".into()), effort: None, capabilities: vec!["code".into(), "review".into()], note: None },
        ],
        native_subagents: false,
    }
}

type Heard = Arc<Mutex<Vec<JobView>>>;

fn service(codex_flags: &[&str]) -> Option<(Delegation, Arc<MockLauncher>, Heard)> {
    let launcher = Arc::new(MockLauncher { python: python()?, codex_flags: codex_flags.iter().map(|f| f.to_string()).collect(), launched: Mutex::default(), released: Mutex::default() });
    let changes = Arc::new(Mutex::new(Vec::new()));
    let seen = changes.clone();
    let delegation = Delegation::new(launcher.clone(), move |job: &JobView| seen.lock().unwrap().push(job.clone()));
    Some((delegation, launcher, changes))
}

/// An MCP client on the far side of the relay: lines in, lines out.
struct Client {
    input: std::io::PipeWriter,
    output: std::sync::mpsc::Receiver<Value>,
    next: u64,
}

struct Lines(std::sync::mpsc::Sender<Value>, Vec<u8>);

impl Write for Lines {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.1.extend_from_slice(buf);
        while let Some(end) = self.1.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.1.drain(..=end).collect();
            if let Ok(value) = serde_json::from_slice(&line) {
                let _ = self.0.send(value);
            }
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Client {
    fn connect(socket: PathBuf, token: String) -> Client {
        let (reader, input) = std::io::pipe().unwrap();
        let (tx, output) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = relay_to(&socket, &token, std::io::BufReader::new(reader), Lines(tx, Vec::new()));
        });
        Client { input, output, next: 1 }
    }

    fn send(&mut self, method: &str, params: Value) -> u64 {
        let id = self.next;
        self.next += 1;
        writeln!(self.input, "{}", json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})).unwrap();
        id
    }

    fn reply(&self, id: u64) -> Value {
        loop {
            let message = self.output.recv_timeout(Duration::from_secs(30)).expect("a reply");
            if message["id"] == id {
                return message;
            }
        }
    }

    fn call(&mut self, tool: &str, arguments: Value) -> Value {
        let id = self.send("tools/call", json!({"name": tool, "arguments": arguments}));
        let reply = tokio::task::block_in_place(|| self.reply(id));
        reply["result"].clone()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_orchestrator_delegates_over_mcp_and_awaits_the_report() {
    let Some((delegation, launcher, changes)) = service(&[]) else { return };
    let dir = tempfile::tempdir().unwrap();
    let socket = DelegationSocket::bind(delegation.clone(), dir.path().join("mcp.sock")).unwrap();
    let token = delegation.register("cx-orchestrator", Provider::Claude, dir.path().to_path_buf(), team());

    // A stranger's token gets nothing.
    let mut stranger = Client::connect(socket.path().to_path_buf(), "not-a-token".into());
    stranger.send("initialize", json!({}));
    assert_eq!(tokio::task::block_in_place(|| stranger.output.recv_timeout(Duration::from_secs(5))).unwrap()["error"], "unknown token");

    let mut client = Client::connect(socket.path().to_path_buf(), token);
    let id = client.send("initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}}));
    let init = tokio::task::block_in_place(|| client.reply(id));
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(init["result"]["serverInfo"]["name"], "team");
    writeln!(client.input, "{}", json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).unwrap();
    let id = client.send("tools/list", json!({}));
    let tools = tokio::task::block_in_place(|| client.reply(id));
    assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 5);

    let workers = client.call("list_workers", json!({}));
    assert_eq!(workers["structuredContent"]["workers"][0]["name"], "luna");
    assert_eq!(workers["structuredContent"]["workers"][0]["availability"], "available");

    // By capability: only luna makes images.
    let started = client.call("delegate", json!({"task": "Draw the icon into assets/icon.png", "capability": "image", "files": ["assets/"]}));
    assert_eq!(started["isError"], false, "{started}");
    let job = started["structuredContent"]["job_id"].as_str().unwrap().to_string();
    assert_eq!(started["structuredContent"]["worker"], "luna");
    // By name.
    let second = client.call("delegate", json!({"task": "Review the diff", "worker": "sonnet"}));
    let review = second["structuredContent"]["job_id"].as_str().unwrap().to_string();

    let done = client.call("await_jobs", json!({"job_ids": [job, review], "timeout_seconds": 30}));
    let jobs = done["structuredContent"]["jobs"].as_array().unwrap().clone();
    assert_eq!(jobs.len(), 2);
    assert!(jobs.iter().all(|job| job["status"] == "succeeded"), "{done}");
    assert_eq!(jobs[0]["report"], "Looking at it.", "the Codex worker's last message is its report");
    assert!(jobs[1]["report"].as_str().unwrap().contains("BIGTHING-REPORT"), "the Claude worker's last message is its report");
    assert!(done["structuredContent"].get("note").is_none());

    // The worker was told the task stands alone, and where to start.
    let specs = launcher.launched.lock().unwrap().clone();
    assert_eq!(specs.len(), 2);
    assert_eq!(specs[0].slot.name, "luna");
    assert_eq!(specs[0].orchestrator, "cx-orchestrator");

    // A follow-up goes to the same worker session.
    let follow = client.call("delegate", json!({"task": "Make it blue", "continue_job": job}));
    assert_eq!(follow["structuredContent"]["continues"], job);
    let follow_id = follow["structuredContent"]["job_id"].as_str().unwrap().to_string();
    let followed = client.call("await_jobs", json!({"job_ids": [follow_id]}));
    assert_eq!(followed["structuredContent"]["jobs"][0]["status"], "succeeded");
    assert_eq!(launcher.launched.lock().unwrap().len(), 2, "no new worker for a follow-up");

    // Unknown workers and tools are errors the model can read.
    let wrong = client.call("delegate", json!({"task": "x", "worker": "gemini"}));
    assert_eq!(wrong["isError"], true);
    assert!(wrong["content"][0]["text"].as_str().unwrap().contains("luna, sonnet"));

    // The UI heard every change, and each job ends settled.
    let heard = changes.lock().unwrap().clone();
    assert!(heard.iter().any(|job| job.status == JobStatus::Running));
    assert_eq!(delegation.jobs("cx-orchestrator").len(), 3);

    delegation.release("cx-orchestrator").await;
    assert_eq!(launcher.released.lock().unwrap().len(), 2, "both workers stopped with their orchestrator");
    assert!(delegation.session_for_token("x").is_none());
    drop(client);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_spent_worker_hands_its_job_to_one_with_room() {
    let Some((delegation, launcher, _)) = service(&["--limit"]) else { return };
    let dir = tempfile::tempdir().unwrap();
    delegation.register("cx-o", Provider::Claude, dir.path().to_path_buf(), team());
    let job = delegation
        .delegate("cx-o", DelegateArgs { task: "Fix the failing test".into(), worker: Some("luna".into()), ..Default::default() })
        .unwrap();
    let jobs = delegation.await_jobs("cx-o", std::slice::from_ref(&job.id), Duration::from_secs(30), false).await.unwrap();
    let job = &jobs[0];
    assert_eq!(job.status, JobStatus::Succeeded, "{job:?}");
    assert_eq!(job.worker, "sonnet", "moved to the worker with the same capability");
    assert!(job.rerouted_from.as_deref().unwrap().starts_with("luna (Codex refused"), "{:?}", job.rerouted_from);
    assert_eq!(launcher.released.lock().unwrap().len(), 1, "the refused worker was stopped");
    assert!(delegation.is_spent(Provider::Codex), "the refusal counts as a spent account");
    let workers = delegation.list_workers("cx-o").unwrap();
    assert!(workers["workers"][0]["availability"].as_str().unwrap().starts_with("out of quota"));

    // With Codex spent, a new image task waits for it rather than failing…
    let queued = delegation.delegate("cx-o", DelegateArgs { task: "Draw".into(), capability: Some("image".into()), ..Default::default() }).unwrap();
    assert_eq!(queued.status, JobStatus::Waiting);
    delegation.cancel("cx-o", &queued.id).await.unwrap();
    // …unless waiting is turned off, when it has nowhere to go and says so.
    delegation.set_retry_policy(RetryPolicy { enabled: false, ..RetryPolicy::default() });
    let error = delegation
        .delegate("cx-o", DelegateArgs { task: "Draw".into(), capability: Some("image".into()), ..Default::default() })
        .unwrap_err();
    assert!(error.contains("unavailable"), "{error}");

    // The team changes mid-session and the next delegate uses it.
    let mut combo = team();
    combo.workers.retain(|worker| worker.provider == Provider::Claude);
    delegation.set_combo("cx-o", combo).unwrap();
    assert_eq!(delegation.list_workers("cx-o").unwrap()["workers"].as_array().unwrap().len(), 1);
    delegation.release("cx-o").await;
}

#[test]
fn the_relay_reports_a_missing_socket() {
    let error = relay_to(std::path::Path::new("/nonexistent/thingmaker.sock"), "t", std::io::BufReader::new(std::io::empty()), std::io::sink()).unwrap_err();
    assert!(matches!(error.kind(), std::io::ErrorKind::NotFound), "{error}");
}

fn quick_retries() -> RetryPolicy {
    RetryPolicy { first_delay_secs: 1, step_secs: 1, max_delay_secs: 2, ..RetryPolicy::default() }
}

fn image_task() -> DelegateArgs {
    DelegateArgs { task: "Draw the logo into assets/logo.png".into(), capability: Some("image".into()), ..Default::default() }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_image_limit_parks_the_job_and_the_same_worker_finishes_it_later() {
    let Some((delegation, launcher, changes)) = service(&["--image-limit-once"]) else { return };
    delegation.set_retry_policy(quick_retries());
    let dir = tempfile::tempdir().unwrap();
    delegation.register("cx-o", Provider::Claude, dir.path().to_path_buf(), team());
    let job = delegation.delegate("cx-o", image_task()).unwrap();
    let done = delegation.await_jobs("cx-o", std::slice::from_ref(&job.id), Duration::from_secs(30), false).await.unwrap();
    let job = &done[0];
    assert_eq!(job.status, JobStatus::Succeeded, "{job:?}");
    assert_eq!(job.result.as_deref(), Some("Saved the logo."));
    assert_eq!(job.attempts, 1);
    assert_eq!(launcher.launched.lock().unwrap().len(), 1, "the same worker session retried, with its context");
    let waited = changes.lock().unwrap().iter().find(|view| view.status == JobStatus::Waiting).cloned().expect("it waited");
    assert!(waited.waiting_reason.as_deref().unwrap().contains("image generation limit"), "{waited:?}");
    assert!(waited.retry_at_unix_ms.is_some());
    delegation.release("cx-o").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_overloaded_server_is_waited_out_and_the_task_sent_again() {
    let Some((delegation, _, changes)) = service(&["--overloaded-once"]) else { return };
    delegation.set_retry_policy(quick_retries());
    let dir = tempfile::tempdir().unwrap();
    delegation.register("cx-o", Provider::Claude, dir.path().to_path_buf(), team());
    let job = delegation.delegate("cx-o", DelegateArgs { task: "Rename the module".into(), worker: Some("luna".into()), ..Default::default() }).unwrap();
    let done = delegation.await_jobs("cx-o", std::slice::from_ref(&job.id), Duration::from_secs(30), false).await.unwrap();
    assert_eq!(done[0].status, JobStatus::Succeeded, "{:?}", done[0]);
    assert!(changes.lock().unwrap().iter().any(|view| view.status == JobStatus::Waiting && view.waiting_reason.as_deref().is_some_and(|reason| reason.contains("temporary error"))));
    assert!(!delegation.is_spent(Provider::Codex), "an overloaded server is not a spent account");
    delegation.release("cx-o").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_job_for_a_spent_account_is_queued_until_it_resets_then_runs() {
    let Some((delegation, launcher, _)) = service(&[]) else { return };
    delegation.set_retry_policy(quick_retries());
    let dir = tempfile::tempdir().unwrap();
    delegation.register("cx-o", Provider::Claude, dir.path().to_path_buf(), team());
    let now = thingmaker_supervisor::delegation::jobs::now_unix_ms();
    delegation.note_quota(thingmaker_supervisor::agents::events::QuotaSnapshot {
        provider: Provider::Codex,
        status: thingmaker_supervisor::agents::events::QuotaStatus::Rejected,
        windows: vec![thingmaker_supervisor::agents::events::QuotaWindow { kind: "primary".into(), used_percent: Some(100.0), window_minutes: Some(300), resets_at: Some(now / 1000 + 2) }],
        plan: None,
        observed_at_unix_ms: now,
    });
    let job = delegation.delegate("cx-o", image_task()).unwrap();
    assert_eq!(job.status, JobStatus::Waiting, "queued, not refused: {job:?}");
    assert!(job.waiting_reason.as_deref().unwrap().contains("out of quota"));
    assert!(launcher.launched.lock().unwrap().is_empty(), "no worker opened while the account is spent");
    let done = delegation.await_jobs("cx-o", std::slice::from_ref(&job.id), Duration::from_secs(30), false).await.unwrap();
    assert_eq!(done[0].status, JobStatus::Succeeded, "{:?}", done[0]);
    assert_eq!(done[0].worker, "luna");
    delegation.release("cx-o").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn past_the_last_retry_the_job_fails_and_keeps_what_the_worker_said() {
    let Some((delegation, _, _)) = service(&["--image-limit-once"]) else { return };
    delegation.set_retry_policy(RetryPolicy { max_attempts: 0, ..quick_retries() });
    let dir = tempfile::tempdir().unwrap();
    delegation.register("cx-o", Provider::Claude, dir.path().to_path_buf(), team());
    let job = delegation.delegate("cx-o", image_task()).unwrap();
    let done = delegation.await_jobs("cx-o", std::slice::from_ref(&job.id), Duration::from_secs(30), false).await.unwrap();
    assert_eq!(done[0].status, JobStatus::Failed);
    assert!(done[0].error.as_deref().unwrap().contains("gave up after 0 retries"), "{:?}", done[0].error);
    assert!(done[0].result.as_deref().unwrap().contains("limit is spent"), "the worker's own words are kept");
    // And the next image job knows the tool is limited: it waits.
    let next = delegation.delegate("cx-o", image_task());
    match next {
        Ok(view) => assert_eq!(view.status, JobStatus::Waiting, "{view:?}"),
        Err(error) => panic!("expected a queued job, got {error}"),
    }
    delegation.release("cx-o").await;
}
