//! The session actor against Codex's app-server, through the bridge.
//!
//! The mock in `packages/test-fixtures/acp/mock-codex-app-server.py` answers
//! to the shape of `codex app-server` 0.158 as captured from the real one: no
//! `jsonrpc` field, threads for sessions, turns that answer at once and end
//! with `turn/completed`, items for messages and tools, and rate limits and
//! token usage on the same stream.

use std::{path::PathBuf, time::Duration};

use thingmaker_supervisor::{
    acp::{LaunchTarget, SessionUpdate, updates::ContentBlock},
    agents::{
        PermissionStance,
        codex::CodexLaunchOptions,
        events::{QuotaStatus, RuntimeEvent, SubagentStatus},
    },
    supervisor::{AgentLaunch, Provider, SessionActor, SessionActorConfig, SessionEvent, SteerOutcome, TurnEffect, TurnPhase},
};

const THREAD: &str = "01a0f24c-75b5-77d0-ba43-9319ccd9e5ef";

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

fn config(flags: &[&str], resume: Option<&str>, permission: PermissionStance) -> Option<SessionActorConfig> {
    let python = python()?;
    let mock = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/test-fixtures/acp/mock-codex-app-server.py").canonicalize().expect("the Codex mock exists");
    let mut options = CodexLaunchOptions::new(std::env::temp_dir(), python.clone());
    options.permission_mode = permission;
    options.model = Some("gpt-6-luna".into());
    options.effort = Some("low".into());
    options.resume = resume.map(str::to_string);
    let mut prefix = vec![mock.to_string_lossy().into_owned()];
    prefix.extend(flags.iter().map(|flag| flag.to_string()));
    let target = LaunchTarget { executable: python, prefix_args: prefix };
    let mut config = SessionActorConfig::new(target, AgentLaunch::Codex(options));
    config.timeouts.turn = Duration::from_secs(10);
    config.timeouts.control = Duration::from_secs(5);
    config.timeouts.shutdown = Duration::from_secs(5);
    Some(config)
}

async fn until_settled(subscription: &mut thingmaker_supervisor::supervisor::EventSubscription) -> Vec<SessionEvent> {
    let mut seen = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let Ok(Some(event)) = tokio::time::timeout(remaining, subscription.recv()).await else {
            panic!("timed out; saw {seen:#?}");
        };
        let settled = matches!(event.payload, SessionEvent::Turn(TurnEffect::Settled { .. }));
        seen.push(event.payload.clone());
        if settled {
            return seen;
        }
    }
}

fn texts(events: &[SessionEvent]) -> Vec<(String, bool, String)> {
    events
        .iter()
        .filter_map(|event| match event {
            SessionEvent::Update(SessionUpdate::AgentMessage(message)) => Some((
                message.message_id.clone(),
                message.replace,
                message.content.iter().filter_map(|block| if let ContentBlock::Text { text } = block { Some(text.as_str()) } else { None }).collect(),
            )),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn a_thread_is_the_session_and_its_options_are_codexs_own() {
    let Some(config) = config(&[], None, PermissionStance::AcceptEdits) else { return };
    let actor = SessionActor::open(config).await.expect("attached");
    let snapshot = actor.snapshot().await.unwrap();
    assert_eq!(snapshot.provider, Provider::Codex);
    assert_eq!(snapshot.agent_session_id.as_deref(), Some(THREAD));
    let capabilities = snapshot.capabilities.unwrap();
    assert_eq!(capabilities.agent_version, "0.158.0-alpha.2.1");
    assert!(capabilities.supports_steering && capabilities.supports_load);
    let options = snapshot.config_options.as_array().unwrap().clone();
    let current = |id: &str| options.iter().find(|o| o["id"] == id).and_then(|o| o["currentValue"].as_str().map(str::to_string));
    // Set by the actor as config options once the thread is open, exactly as
    // for an ACP agent.
    assert_eq!(current("model").as_deref(), Some("gpt-6-luna"));
    assert_eq!(current("effort").as_deref(), Some("low"));
    assert_eq!(current("mode").as_deref(), Some("workspace-write"));
    let _ = actor.stop().await;
}

#[tokio::test]
async fn a_turn_streams_messages_tools_subagents_usage_and_quota_then_settles() {
    let Some(config) = config(&[], None, PermissionStance::AcceptEdits) else { return };
    let actor = SessionActor::open(config).await.expect("attached");
    let mut subscription = actor.subscribe();
    actor.submit_text("r1", "do the thing").await.expect("submitted");
    let events = until_settled(&mut subscription).await;

    assert!(events.iter().any(|event| matches!(event, SessionEvent::Turn(TurnEffect::Settled { phase: TurnPhase::Succeeded, .. }))));
    let messages = texts(&events);
    let streamed: String = messages.iter().filter(|(id, replace, _)| id == "msg_1" && !replace).map(|(_, _, text)| text.as_str()).collect();
    assert_eq!(streamed, "Looking at it.");
    assert!(messages.iter().any(|(id, replace, text)| id == "msg_1" && *replace && text == "Looking at it."), "the completed item lands as the full message");
    assert!(!messages.iter().any(|(_, _, text)| text.contains("subagent chatter")), "a subagent's own thread stays out of the session");
    // The prompt is in the stream as soon as Codex has it, ahead of the
    // work; Codex's own echo of it is not shown a second time.
    let users: Vec<(usize, String, String)> = events
        .iter()
        .enumerate()
        .filter_map(|(at, event)| match event {
            SessionEvent::Update(SessionUpdate::UserMessage(message)) => Some((
                at,
                message.message_id.clone(),
                message.content.iter().filter_map(|block| if let ContentBlock::Text { text } = block { Some(text.as_str()) } else { None }).collect(),
            )),
            _ => None,
        })
        .collect();
    assert_eq!(users.len(), 1, "{users:?}");
    assert!(users[0].1.starts_with("prompt-r1"), "{users:?}");
    assert_eq!(users[0].2, "do the thing");
    let first_agent = events.iter().position(|event| matches!(event, SessionEvent::Update(SessionUpdate::AgentMessage(_)))).unwrap();
    assert!(users[0].0 < first_agent, "the prompt comes before the reply");

    let tool = events.iter().find_map(|event| match event {
        SessionEvent::Update(SessionUpdate::ToolCallUpdate(patch)) if patch.tool_call_id.as_deref() == Some("cmd_2") => Some(patch.clone()),
        _ => None,
    });
    let tool = tool.expect("the command completes as a tool call");
    assert_eq!(tool.status.as_deref(), Some("completed"));
    assert_eq!(tool.raw_output.as_ref().unwrap()["exitCode"], 0);

    let spawned: Vec<(String, SubagentStatus, Option<String>)> = events
        .iter()
        .filter_map(|event| match event {
            SessionEvent::RuntimeEvent(RuntimeEvent::SubagentStateChanged { name, status, model, harness, .. }) if harness == "codex" => Some((name.clone(), *status, model.clone())),
            _ => None,
        })
        .collect();
    assert!(spawned.iter().any(|(name, status, model)| name == "7.3-pricing" && *status == SubagentStatus::Working && model.as_deref() == Some("gpt-6-luna")));
    assert!(spawned.iter().any(|(name, status, _)| name == "7.3-pricing" && *status == SubagentStatus::Idle));

    assert!(events.iter().any(|event| matches!(event, SessionEvent::Update(SessionUpdate::Usage(usage)) if usage.used == Some(17198) && usage.size == Some(258400))));
    let quota = events.iter().find_map(|event| if let SessionEvent::Quota(quota) = event { Some(quota.clone()) } else { None }).expect("a quota event");
    assert_eq!(quota.provider, Provider::Codex);
    assert_eq!(quota.status, QuotaStatus::Allowed);
    assert_eq!(quota.windows[1].used_percent, Some(71.0));

    // The model and effort the actor set went out on the turn itself.
    let history = actor.history(0, 10_000).await.unwrap();
    let turn = history
        .iter()
        .find_map(|event| match &event.payload {
            SessionEvent::Diagnostic { text } if text.starts_with("turn: ") => Some(text.clone()),
            _ => None,
        })
        .expect("the mock echoes turn/start");
    assert!(turn.contains(r#""model": "gpt-6-luna""#) && turn.contains(r#""effort": "low""#), "{turn}");
    assert!(turn.contains("workspaceWrite"), "{turn}");
    let _ = actor.stop().await;
}

#[tokio::test]
async fn an_approval_is_answered_by_the_workspaces_trust() {
    for (permission, decision) in [(PermissionStance::AcceptEdits, "accept"), (PermissionStance::ReadOnly, "decline")] {
        let Some(config) = config(&["--ask"], None, permission) else { return };
        let actor = SessionActor::open(config).await.expect("attached");
        let mut subscription = actor.subscribe();
        actor.submit_text("r1", "run the tests").await.expect("submitted");
        let events = until_settled(&mut subscription).await;
        let asked = events.iter().find_map(|event| match event {
            SessionEvent::PermissionRequest { title, decision, .. } => Some((title.clone(), *decision)),
            _ => None,
        });
        let (title, answered) = asked.expect("the approval reached the stream");
        assert_eq!(title.as_deref(), Some("Run `pnpm test`"));
        assert_eq!(answered, if decision == "accept" { "allowed" } else { "cancelled" });
        let history = actor.history(0, 10_000).await.unwrap();
        let answer = history
            .iter()
            .find_map(|event| match &event.payload {
                SessionEvent::Diagnostic { text } if text.starts_with("answer: ") => Some(text.clone()),
                _ => None,
            })
            .expect("the mock echoes the answer");
        assert!(answer.contains(&format!(r#""decision": "{decision}""#)), "{answer}");
        let _ = actor.stop().await;
    }
}

#[tokio::test]
async fn a_tool_of_the_sessions_own_server_is_approved_and_a_strangers_form_declined() {
    let Some(mut config) = config(&["--elicit"], None, PermissionStance::AcceptEdits) else { return };
    config.mcp_servers = vec![serde_json::json!({"name": "team", "command": "/usr/bin/true", "args": [], "env": []})];
    let actor = SessionActor::open(config).await.expect("attached");
    let mut subscription = actor.subscribe();
    actor.submit_text("r1", "delegate it").await.expect("submitted");
    let events = until_settled(&mut subscription).await;
    let asked: Vec<(Option<String>, &str)> = events
        .iter()
        .filter_map(|event| match event {
            SessionEvent::PermissionRequest { title, decision, .. } => Some((title.clone(), *decision)),
            _ => None,
        })
        .collect();
    assert_eq!(asked.len(), 1, "only the session's own server reaches the stance: {asked:?}");
    assert_eq!(asked[0].0.as_deref(), Some("Allow the team MCP server to run tool \"delegate\"?"));
    let history = actor.history(0, 10_000).await.unwrap();
    let answers: Vec<String> = history
        .iter()
        .filter_map(|event| match &event.payload {
            SessionEvent::Diagnostic { text } if text.starts_with("answer: ") => Some(text.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(answers.len(), 2, "{answers:?}");
    assert!(answers.iter().any(|answer| answer.contains(r#""action": "accept""#)), "{answers:?}");
    assert!(answers.iter().any(|answer| answer.contains(r#""action": "decline""#)), "{answers:?}");
    let _ = actor.stop().await;
}

#[tokio::test]
async fn a_spent_account_fails_the_turn_as_a_rate_limit() {
    let Some(config) = config(&["--limit"], None, PermissionStance::AcceptEdits) else { return };
    let actor = SessionActor::open(config).await.expect("attached");
    let mut subscription = actor.subscribe();
    actor.submit_text("r1", "do the thing").await.expect("submitted");
    let events = until_settled(&mut subscription).await;
    let error = events
        .iter()
        .find_map(|event| match event {
            SessionEvent::Turn(TurnEffect::Settled { phase: TurnPhase::Failed, error, .. }) => error.clone(),
            _ => None,
        })
        .expect("a failed turn");
    // The words the runner parks on rather than blocks.
    assert!(error.contains("rate_limit") && error.contains("usage limit"), "{error}");
    let _ = actor.stop().await;
}

#[tokio::test]
async fn resuming_replays_the_thread_and_steering_reaches_the_turn() {
    let Some(config) = config(&[], Some(THREAD), PermissionStance::AcceptEdits) else { return };
    let actor = SessionActor::open(config).await.expect("attached");
    let history = actor.history(0, 10_000).await.unwrap();
    let replayed: Vec<String> = history
        .iter()
        .filter_map(|event| match &event.payload {
            SessionEvent::Update(SessionUpdate::AgentMessage(message)) | SessionEvent::Update(SessionUpdate::UserMessage(message)) => {
                message.content.iter().find_map(|block| if let ContentBlock::Text { text } = block { Some(text.clone()) } else { None })
            }
            _ => None,
        })
        .collect();
    assert_eq!(replayed, ["earlier ask", "earlier work"]);
    assert_eq!(actor.snapshot().await.unwrap().agent_session_id.as_deref(), Some(THREAD));

    // Nothing is running, so there is nothing to steer; the bridge says so
    // rather than inventing a turn.
    let outcome = actor.steer_text("also the changelog").await.expect("a reply");
    assert!(matches!(outcome, SteerOutcome::Rejected { .. }), "{outcome:?}");
    let _ = actor.stop().await;
}
