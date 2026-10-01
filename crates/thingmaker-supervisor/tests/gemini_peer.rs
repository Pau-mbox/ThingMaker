//! The session actor against Antigravity's `agy`, through the Gemini bridge.
//!
//! The mock in `packages/test-fixtures/acp/mock-agy.py` answers to the shape
//! of `agy` 1.2.14 in stream-json mode, as captured live on 1 October 2026.

use std::{path::PathBuf, time::Duration};

use thingmaker_supervisor::{
    acp::{LaunchTarget, SessionUpdate, updates::ContentBlock},
    agents::{PermissionStance, gemini::GeminiLaunchOptions},
    supervisor::{AgentLaunch, Provider, SessionActor, SessionActorConfig, SessionEvent, SteerOutcome, TurnEffect, TurnPhase},
};

const KNOWN: &str = "c0ffee00-0000-4000-8000-000000000001";

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
    let mock = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/test-fixtures/acp/mock-agy.py").canonicalize().expect("the agy mock exists");
    let mut options = GeminiLaunchOptions::new(std::env::temp_dir(), python.clone());
    options.permission_mode = permission;
    options.model = Some("gemini-3.8-flash-low".into());
    options.resume = resume.map(str::to_string);
    let mut prefix = vec![mock.to_string_lossy().into_owned()];
    prefix.extend(flags.iter().map(|flag| flag.to_string()));
    let mut config = SessionActorConfig::new(LaunchTarget { executable: python, prefix_args: prefix }, AgentLaunch::Gemini(options));
    config.timeouts.turn = Duration::from_secs(20);
    config.timeouts.control = Duration::from_secs(10);
    config.timeouts.shutdown = Duration::from_secs(5);
    Some(config)
}

async fn until_settled(subscription: &mut thingmaker_supervisor::supervisor::EventSubscription) -> Vec<SessionEvent> {
    let mut seen = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
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

fn agent_text(events: &[SessionEvent]) -> String {
    events
        .iter()
        .filter_map(|event| match event {
            SessionEvent::Update(SessionUpdate::AgentMessage(message)) => {
                Some(message.content.iter().filter_map(|block| if let ContentBlock::Text { text } = block { Some(text.as_str()) } else { None }).collect::<String>())
            }
            _ => None,
        })
        .collect()
}

async fn launches(actor: &SessionActor) -> Vec<Vec<String>> {
    actor
        .history(0, 10_000)
        .await
        .unwrap()
        .iter()
        .filter_map(|event| match &event.payload {
            SessionEvent::Diagnostic { text } => text.strip_prefix("argv: ").and_then(|json| serde_json::from_str(json).ok()),
            _ => None,
        })
        .collect()
}

fn settled_phase(events: &[SessionEvent]) -> Option<(TurnPhase, Option<String>)> {
    events.iter().find_map(|event| match event {
        SessionEvent::Turn(TurnEffect::Settled { phase, error, .. }) => Some((*phase, error.clone())),
        _ => None,
    })
}

#[tokio::test]
async fn the_conversation_is_the_session_and_a_trusted_workspace_skips_the_prompts() {
    let Some(config) = config(&[], None, PermissionStance::AcceptEdits) else { return };
    let actor = SessionActor::open(config).await.expect("attached");
    let snapshot = actor.snapshot().await.unwrap();
    assert_eq!(snapshot.provider, Provider::Gemini);
    assert_eq!(snapshot.agent_session_id.as_deref(), Some(KNOWN), "agy names its conversation before any prompt");
    let capabilities = snapshot.capabilities.unwrap();
    assert!(!capabilities.supports_steering, "input during a turn only queues");
    let options = snapshot.config_options.as_array().unwrap().clone();
    let current = |id: &str| options.iter().find(|o| o["id"] == id).and_then(|o| o["currentValue"].as_str().map(str::to_string));
    assert_eq!(current("mode").as_deref(), Some("accept-edits"));
    assert_eq!(current("model").as_deref(), Some("gemini-3.8-flash-low"));

    let argv = &launches(&actor).await[0];
    assert!(argv.windows(2).any(|pair| pair == ["--mode", "accept-edits"]));
    assert!(argv.contains(&"--dangerously-skip-permissions".to_string()));
    assert!(argv.windows(2).any(|pair| pair == ["--model", "gemini-3.8-flash-low"]));
    // The actor refuses before asking: the capability says there is none.
    match actor.steer_text("also this").await {
        Err(error) => assert!(error.message.contains("steering"), "{}", error.message),
        Ok(outcome) => assert!(matches!(outcome, SteerOutcome::Rejected { .. }), "{outcome:?}"),
    }
    let _ = actor.stop().await;
}

#[tokio::test]
async fn a_turn_streams_the_answer_tools_and_usage_then_settles() {
    let Some(config) = config(&[], None, PermissionStance::ReadOnly) else { return };
    let actor = SessionActor::open(config).await.expect("attached");
    let mut subscription = actor.subscribe();
    actor.submit_text("r1", "say hi").await.expect("submitted");
    let events = until_settled(&mut subscription).await;
    assert_eq!(settled_phase(&events).unwrap().0, TurnPhase::Succeeded);
    assert_eq!(agent_text(&events).trim(), "Echo: say hi");
    assert!(events.iter().any(|event| matches!(event, SessionEvent::Update(SessionUpdate::UserMessage(_)))), "the prompt is echoed as the user's message");
    let tools: Vec<(Option<String>, Option<String>)> = events
        .iter()
        .filter_map(|event| match event {
            SessionEvent::Update(SessionUpdate::ToolCallUpdate(patch)) | SessionEvent::Update(SessionUpdate::ToolCall(patch)) => Some((patch.title.clone(), patch.status.clone())),
            _ => None,
        })
        .collect();
    assert!(tools.iter().any(|(title, _)| title.as_deref() == Some("Write /tmp/hello.txt")), "{tools:?}");
    assert!(tools.iter().any(|(_, status)| status.as_deref() == Some("failed")), "the refused command shows as failed: {tools:?}");
    assert!(events.iter().any(|event| matches!(event, SessionEvent::Update(SessionUpdate::Usage(usage)) if usage.used == Some(13798))));
    assert!(events.iter().any(|event| matches!(event, SessionEvent::Diagnostic { text } if text.contains("refused RunCommand"))), "denials are reported");
    let argv = &launches(&actor).await[0];
    assert!(argv.windows(2).any(|pair| pair == ["--mode", "plan"]));
    assert!(!argv.contains(&"--dangerously-skip-permissions".to_string()), "a read-only workspace never skips a prompt");
    let _ = actor.stop().await;
}

#[tokio::test]
async fn a_model_change_relaunches_on_the_same_conversation_before_the_next_turn() {
    let Some(config) = config(&[], None, PermissionStance::AcceptEdits) else { return };
    let actor = SessionActor::open(config).await.expect("attached");
    actor.set_config_option("model", serde_json::json!("gemini-3.1-pro-high")).await.expect("set");
    let mut subscription = actor.subscribe();
    actor.submit_text("r1", "again").await.expect("submitted");
    let events = until_settled(&mut subscription).await;
    assert_eq!(settled_phase(&events).unwrap().0, TurnPhase::Succeeded);
    let all = launches(&actor).await;
    assert_eq!(all.len(), 2, "one relaunch: {all:?}");
    assert!(all[1].windows(2).any(|pair| pair == ["--model", "gemini-3.1-pro-high"]));
    assert!(all[1].windows(2).any(|pair| pair == ["--conversation", KNOWN]), "the context is kept");
    assert_eq!(actor.snapshot().await.unwrap().agent_session_id.as_deref(), Some(KNOWN));
    let _ = actor.stop().await;
}

#[tokio::test]
async fn a_spent_account_fails_the_turn_as_a_rate_limit() {
    let Some(config) = config(&["--mock-limit"], None, PermissionStance::AcceptEdits) else { return };
    let actor = SessionActor::open(config).await.expect("attached");
    let mut subscription = actor.subscribe();
    actor.submit_text("r1", "do it").await.expect("submitted");
    let events = until_settled(&mut subscription).await;
    let (phase, error) = settled_phase(&events).unwrap();
    assert_eq!(phase, TurnPhase::Failed);
    let error = error.unwrap();
    assert!(error.contains("rate_limit") && error.contains("quota"), "{error}");
    let _ = actor.stop().await;
}

#[tokio::test]
async fn a_cancel_ends_the_turn_and_the_next_one_continues_the_conversation() {
    let Some(config) = config(&["--mock-slow"], None, PermissionStance::AcceptEdits) else { return };
    let actor = SessionActor::open(config).await.expect("attached");
    let mut subscription = actor.subscribe();
    actor.submit_text("r1", "count").await.expect("submitted");
    // Let it start answering, then cancel.
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), subscription.recv()).await.unwrap().unwrap();
        if matches!(event.payload, SessionEvent::Update(SessionUpdate::AgentMessage(_))) {
            break;
        }
    }
    actor.cancel().await.expect("cancel");
    let events = until_settled(&mut subscription).await;
    assert_eq!(settled_phase(&events).unwrap().0, TurnPhase::Cancelled, "{events:#?}");
    assert!(!events.iter().any(|event| matches!(event, SessionEvent::Exited(_))), "the actor never sees the process go");

    actor.submit_text("r2", "go on").await.expect("submitted");
    let events = until_settled(&mut subscription).await;
    assert_eq!(settled_phase(&events).unwrap().0, TurnPhase::Succeeded, "{events:#?}");
    let all = launches(&actor).await;
    assert_eq!(all.len(), 2);
    assert!(all[1].windows(2).any(|pair| pair == ["--conversation", KNOWN]));
    let _ = actor.stop().await;
}

#[tokio::test]
async fn resuming_a_conversation_agy_does_not_have_is_refused() {
    let Some(known) = config(&[], Some(KNOWN), PermissionStance::AcceptEdits) else { return };
    let actor = SessionActor::open(known).await.expect("a known conversation resumes");
    assert_eq!(actor.snapshot().await.unwrap().agent_session_id.as_deref(), Some(KNOWN));
    let _ = actor.stop().await;

    let Some(missing) = config(&[], Some("1a2b3c4d-0000-4000-8000-00000000dead"), PermissionStance::AcceptEdits) else { return };
    let error = SessionActor::open(missing).await.expect_err("agy started a new conversation instead");
    assert!(error.message.contains("not found") || error.message.contains("no conversation"), "{}", error.message);
}
