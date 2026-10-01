//! The session actor against the Claude adapter.
//!
//! The mock in `packages/test-fixtures/acp/mock-claude-acp.py` answers to the
//! shape of `claude-agent-acp` 0.84.0 as captured from the real program: ACP
//! protocol version 1, `agentInfo`, a session id of the agent's own choosing,
//! config options for model and permission mode, a `session/prompt` that
//! answers at turn end, message chunks with no `messageId`, the account's rate
//! limit on usage updates, steering under `_session/steering`, and subagents
//! as `Task` tool calls.

use std::{path::PathBuf, time::Duration};

use thingmaker_supervisor::{
    acp::{LaunchTarget, SessionUpdate, updates::ContentBlock},
    agents::{
        PermissionStance,
        claude::launch::{self as claude_launch, ClaudeLaunchOptions},
        events::{QuotaStatus, RuntimeEvent, SubagentStatus},
    },
    supervisor::{AgentLaunch, Provider, SessionActor, SessionActorConfig, SessionEvent, SteerOutcome},
};

const AGENT_SESSION: &str = "d847b2a3-c7b5-4459-8b0f-02fdd03031a4";

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

fn mock() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/test-fixtures/acp/mock-claude-acp.py")
        .canonicalize()
        .expect("the Claude mock fixture exists")
}

fn config(flags: &[&str], resume: Option<&str>, permission: PermissionStance, root: &std::path::Path) -> Option<SessionActorConfig> {
    let python = python()?;
    let mut args = vec![mock().to_string_lossy().into_owned()];
    args.extend(flags.iter().map(|flag| flag.to_string()));
    let mut options = ClaudeLaunchOptions::new(root, python.clone(), args);
    options.model = Some(claude_launch::CLAUDE_ORCHESTRATOR_MODEL.into());
    options.model_fallback = Some(claude_launch::CLAUDE_ORCHESTRATOR_FALLBACK.into());
    options.effort = Some(claude_launch::CLAUDE_ORCHESTRATOR_EFFORT.into());
    options.permission_mode = permission;
    options.resume = resume.map(str::to_string);
    let mut config = SessionActorConfig::new(LaunchTarget::executable(python), AgentLaunch::Claude(options));
    config.timeouts.turn = Duration::from_secs(10);
    config.timeouts.control = Duration::from_secs(5);
    config.timeouts.shutdown = Duration::from_secs(5);
    Some(config)
}

/// Drains a stream for up to `timeout`, returning every event seen.
///
/// The subscription is taken by the caller, before whatever it is waiting for
/// is set in motion: a turn can be over before a subscription made after the
/// submit is listening, and the event is then simply never seen.
async fn collect(
    subscription: &mut thingmaker_supervisor::supervisor::EventSubscription,
    timeout: Duration,
    mut done: impl FnMut(&SessionEvent) -> bool,
) -> Vec<SessionEvent> {
    let mut seen = Vec::new();
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            panic!("timed out; saw {seen:#?}");
        }
        match tokio::time::timeout(remaining, subscription.recv()).await {
            Ok(Some(event)) => {
                let matched = done(&event.payload);
                seen.push(event.payload.clone());
                if matched {
                    return seen;
                }
            }
            Ok(None) => panic!("stream closed; saw {seen:#?}"),
            Err(_) => panic!("timed out; saw {seen:#?}"),
        }
    }
}

#[tokio::test]
async fn the_adapter_names_the_session_and_the_desktop_adopts_its_id() {
    let Some(config) = config(&[], None, PermissionStance::AcceptEdits, &std::env::temp_dir()) else {
        eprintln!("python is not available; skipping");
        return;
    };
    let actor = SessionActor::open(config).await.expect("attached");
    let snapshot = actor.snapshot().await.expect("snapshot");

    // The reservation is a placeholder: the session the transcript is
    // written under is the one `session/new` answered with.
    assert_eq!(snapshot.agent_session_id.as_deref(), Some(AGENT_SESSION));
    assert_ne!(snapshot.handle.id, AGENT_SESSION, "the handle is the desktop's own key");
    assert_eq!(snapshot.provider, Provider::Claude);

    let capabilities = snapshot.capabilities.expect("capabilities");
    assert_eq!(capabilities.protocol_version, 1);
    assert_eq!(capabilities.agent_version, "0.84.0");
    assert!(capabilities.supports_steering, "the adapter advertises `_session/steering`");

    // Model and permission mode are config options here, not launch flags,
    // and they are applied before the attachment is reported ready.
    let options = snapshot.config_options.as_array().expect("config options");
    let current = |id: &str| {
        options
            .iter()
            .find(|option| option.get("id").and_then(|value| value.as_str()) == Some(id))
            .and_then(|option| option.get("currentValue"))
            .and_then(|value| value.as_str())
            .map(str::to_string)
    };
    assert_eq!(current("model").as_deref(), Some(claude_launch::CLAUDE_ORCHESTRATOR_MODEL));
    assert_eq!(current("mode").as_deref(), Some("acceptEdits"));
    let _ = actor.stop().await;
}

#[tokio::test]
async fn a_task_tool_call_is_reported_as_the_subagent_event_the_desktop_already_reads() {
    let Some(config) = config(&[], None, PermissionStance::AcceptEdits, &std::env::temp_dir()) else {
        eprintln!("python is not available; skipping");
        return;
    };
    let actor = SessionActor::open(config).await.expect("attached");
    let mut subscription = actor.subscribe();
    actor.submit_text("r1", "do the thing").await.expect("submitted");
    let events = collect(&mut subscription, Duration::from_secs(10), |event| {
        matches!(event, SessionEvent::RuntimeEvent(RuntimeEvent::SubagentStateChanged { status: SubagentStatus::Idle, .. }))
    })
    .await;

    let subagents: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            SessionEvent::RuntimeEvent(RuntimeEvent::SubagentStateChanged { name, status, harness, model, .. }) => {
                Some((name.clone(), *status, harness.clone(), model.clone()))
            }
            _ => None,
        })
        .collect();
    // Without this translation the inspector, the run monitor and the task
    // owner column would all be blank under a Claude orchestrator.
    assert!(subagents.iter().any(|(name, status, ..)| name == "7.3-pricing" && *status == SubagentStatus::Working));
    assert!(subagents.iter().any(|(name, status, ..)| name == "7.3-pricing" && *status == SubagentStatus::Idle));
    // The harness says where the row came from, and the model is the one the
    // session is actually on rather than the one the desktop asked for.
    assert!(subagents.iter().all(|(_, _, harness, model)| harness == "claude-code" && model.as_deref() == Some(claude_launch::CLAUDE_ORCHESTRATOR_MODEL)));
    let _ = actor.stop().await;
}

#[tokio::test]
async fn a_trusted_workspace_allows_what_it_is_asked_and_a_read_only_one_refuses() {
    for (permission, expected) in [(PermissionStance::AcceptEdits, "allowed"), (PermissionStance::ReadOnly, "cancelled")] {
        let Some(config) = config(&["--ask"], None, permission, &std::env::temp_dir()) else {
            eprintln!("python is not available; skipping");
            return;
        };
        let actor = SessionActor::open(config).await.expect("attached");
        let mut subscription = actor.subscribe();
        actor.submit_text("r1", "run the check").await.expect("submitted");
        let events = collect(&mut subscription, Duration::from_secs(10), |event| matches!(event, SessionEvent::PermissionRequest { .. })).await;
        let decision = events
            .iter()
            .find_map(|event| match event {
                SessionEvent::PermissionRequest { decision, .. } => Some(*decision),
                _ => None,
            })
            .expect("a permission request");
        // An orchestrator runs unattended for hours: `cancelled` would end the
        // run at its first edit. The stance comes from the workspace's trust
        // state and nothing else.
        assert_eq!(decision, expected, "under {permission:?}");
        let _ = actor.stop().await;
    }
}

#[tokio::test]
async fn resuming_hands_the_adapter_back_the_id_it_gave_out() {
    let Some(config) = config(&[], Some(AGENT_SESSION), PermissionStance::AcceptEdits, &std::env::temp_dir()) else {
        eprintln!("python is not available; skipping");
        return;
    };
    let actor = SessionActor::open(config).await.expect("attached");
    let snapshot = actor.snapshot().await.expect("snapshot");
    // `session/load`, and the id is the adapter's own from the previous run
    // rather than one the desktop invented.
    assert_eq!(snapshot.agent_session_id.as_deref(), Some(AGENT_SESSION));
    assert_eq!(snapshot.handle.id, AGENT_SESSION);
    let _ = actor.stop().await;
}

#[tokio::test]
async fn a_prompt_answered_only_at_turn_end_is_accepted_when_it_reaches_the_agent() {
    // The bug this is for, seen on a live run: the adapter answers
    // `session/prompt` with the finished turn, not with an acknowledgement.
    // Held to a 30-second acceptance deadline, the desktop called the timeout
    // a refused prompt and blocked the goal — every turn — while the agent
    // went on working, subagents and all.
    let Some(config) = config(&[], None, PermissionStance::AcceptEdits, &std::env::temp_dir()) else {
        eprintln!("python is not available; skipping");
        return;
    };
    let actor = SessionActor::open(config).await.expect("attached");
    let mut subscription = actor.subscribe();

    let outcome = actor.submit_text("r1", "do the thing").await.expect("a reply");
    assert!(
        matches!(outcome, thingmaker_supervisor::supervisor::SubmissionOutcome::Accepted),
        "reaching the agent's input is the acceptance, got {outcome:?}"
    );

    // And the turn still settles from the update stream, as a real turn.
    let events = collect(&mut subscription, Duration::from_secs(10), |event| {
        matches!(event, SessionEvent::Turn(thingmaker_supervisor::supervisor::TurnEffect::Settled { .. }))
    })
    .await;
    let settled = events.iter().any(|event| {
        matches!(event, SessionEvent::Turn(thingmaker_supervisor::supervisor::TurnEffect::Settled { phase, .. }) if *phase == thingmaker_supervisor::supervisor::TurnPhase::Succeeded)
    });
    assert!(settled, "the turn settled succeeded; saw {events:#?}");
    let _ = actor.stop().await;
}

#[tokio::test]
async fn a_refusal_that_arrives_after_acceptance_settles_the_turn_with_its_message() {
    // Once the submit is answered at the write, the request's eventual error
    // is the only thing that can report a spent account — and if it settled
    // nothing the run would wait for ever on a turn that never started.
    let Some(config) = config(&["--limit"], None, PermissionStance::AcceptEdits, &std::env::temp_dir()) else {
        eprintln!("python is not available; skipping");
        return;
    };
    let actor = SessionActor::open(config).await.expect("attached");
    let mut subscription = actor.subscribe();
    let _ = actor.submit_text("r1", "do the thing").await.expect("a reply");

    let events = collect(&mut subscription, Duration::from_secs(10), |event| {
        matches!(event, SessionEvent::Turn(thingmaker_supervisor::supervisor::TurnEffect::Settled { .. }))
    })
    .await;
    let message = events
        .iter()
        .find_map(|event| match event {
            SessionEvent::Turn(thingmaker_supervisor::supervisor::TurnEffect::Settled { phase, error, .. })
                if *phase == thingmaker_supervisor::supervisor::TurnPhase::Failed =>
            {
                error.clone()
            }
            _ => None,
        })
        .expect("a failed turn carrying the refusal");
    // The quota reader has to be able to see it, or the run blocks instead of
    // parking.
    assert!(thingmaker_supervisor::agents::claude::quota::looks_like_rate_limit(&message), "{message}");
    let _ = actor.stop().await;
}

#[tokio::test]
async fn the_preferred_model_is_selected_with_its_effort_and_falls_back_when_refused() {
    // Fable is the orchestrator's preference and is billed against usage
    // credits rather than the subscription, so it is the one model that can
    // run out while the account is otherwise fine. Landing on Opus is a
    // working run on a cheaper model; refusing to land is no run at all.
    let Some(config) = config(&["--refuse-model=claude-fable-5-1"], None, PermissionStance::AcceptEdits, &std::env::temp_dir()) else {
        eprintln!("python is not available; skipping");
        return;
    };
    let actor = SessionActor::open(config).await.expect("attached");
    let snapshot = actor.snapshot().await.expect("snapshot");
    let current = |id: &str| {
        snapshot
            .config_options
            .as_array()
            .and_then(|options| options.iter().find(|option| option.get("id").and_then(|v| v.as_str()) == Some(id)))
            .and_then(|option| option.get("currentValue"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    assert_eq!(current("model").as_deref(), Some("opus"), "fell back rather than staying on a model it could not select");
    // The effort is asked for whichever model it landed on: a long-horizon
    // run is mostly planning and reading, which is what effort buys.
    assert_eq!(current("effort").as_deref(), Some("high"));
    let _ = actor.stop().await;
}

#[tokio::test]
async fn the_preferred_model_is_kept_when_the_account_offers_it() {
    let Some(config) = config(&[], None, PermissionStance::AcceptEdits, &std::env::temp_dir()) else {
        eprintln!("python is not available; skipping");
        return;
    };
    let actor = SessionActor::open(config).await.expect("attached");
    let snapshot = actor.snapshot().await.expect("snapshot");
    let model = snapshot
        .config_options
        .as_array()
        .and_then(|options| options.iter().find(|option| option.get("id").and_then(|v| v.as_str()) == Some("model")))
        .and_then(|option| option.get("currentValue"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    assert_eq!(model.as_deref(), Some("claude-fable-5-1"));
    let _ = actor.stop().await;
}

#[tokio::test]
async fn chunks_without_ids_become_one_message_per_run_and_the_quota_is_lifted_out() {
    let Some(config) = config(&[], None, PermissionStance::AcceptEdits, &std::env::temp_dir()) else {
        eprintln!("python is not available; skipping");
        return;
    };
    let actor = SessionActor::open(config).await.expect("attached");
    let mut subscription = actor.subscribe();
    actor.submit_text("r1", "do the thing").await.expect("submitted");
    let events = collect(&mut subscription, Duration::from_secs(10), |event| {
        matches!(event, SessionEvent::Turn(thingmaker_supervisor::supervisor::TurnEffect::Settled { .. }))
    })
    .await;

    // The real adapter sends no `messageId`. Rejecting such chunks dropped
    // every word it said; now the two chunks before the tool call are one
    // message and the one after it another.
    let messages: Vec<(String, String)> = events
        .iter()
        .filter_map(|event| match event {
            SessionEvent::Update(SessionUpdate::AgentMessage(message)) => Some((
                message.message_id.clone(),
                message
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect(),
            )),
            _ => None,
        })
        .collect();
    assert!(messages.iter().all(|(id, _)| !id.is_empty()), "{messages:?}");
    let first: String = messages.iter().filter(|(id, _)| *id == messages[0].0).map(|(_, text)| text.as_str()).collect();
    assert_eq!(first, "Looking at it.");
    let last = messages.last().unwrap();
    assert_ne!(last.0, messages[0].0, "text after a tool call is a new message");
    assert!(last.1.starts_with("SUPERTHING-REPORT"));

    let quota = events
        .iter()
        .find_map(|event| match event {
            SessionEvent::Quota(quota) => Some(quota.clone()),
            _ => None,
        })
        .expect("the rate limit on the usage update became a quota event");
    assert_eq!(quota.provider, Provider::Claude);
    assert_eq!(quota.status, QuotaStatus::Warning);
    assert_eq!(quota.windows[0].kind, "five_hour");
    let _ = actor.stop().await;
}

#[tokio::test]
async fn a_running_turn_is_steered_through_the_adapters_extension() {
    let Some(config) = config(&[], None, PermissionStance::AcceptEdits, &std::env::temp_dir()) else {
        eprintln!("python is not available; skipping");
        return;
    };
    let actor = SessionActor::open(config).await.expect("attached");
    let outcome = actor.steer_text("also update the changelog").await.expect("a reply");
    assert!(matches!(outcome, SteerOutcome::Accepted { .. }), "{outcome:?}");
    let _ = actor.stop().await;
}

#[tokio::test]
async fn an_orchestrator_that_may_not_start_subagents_says_so_to_the_sdk() {
    let Some(mut config) = config(&[], None, PermissionStance::AcceptEdits, &std::env::temp_dir()) else {
        eprintln!("python is not available; skipping");
        return;
    };
    let AgentLaunch::Claude(options) = &mut config.launch else { unreachable!("a Claude launch") };
    options.disallowed_tools = vec!["Agent".into(), "Task".into()];
    let actor = SessionActor::open(config).await.expect("attached");
    let history = actor.history(0, 1000).await.expect("history");
    let meta = history
        .iter()
        .find_map(|event| match &event.payload {
            SessionEvent::Diagnostic { text } if text.starts_with("meta: ") => Some(text.clone()),
            _ => None,
        })
        .expect("the mock echoes session/new's _meta");
    assert!(meta.contains(r#""disallowedTools": ["Agent", "Task"]"#), "{meta}");
    let _ = actor.stop().await;
}

/// A turn that has gone quiet is ended; a turn waiting in a tool call is not.
/// An orchestrator spends hours in one turn waiting on its workers through
/// `await_jobs`, and a fixed ceiling on the turn cut it off mid-run.
#[tokio::test]
async fn a_silent_turn_is_cancelled_and_a_turn_waiting_in_a_tool_is_not() {
    let root = tempfile::tempdir().unwrap();
    let Some(mut silent) = config(&["--hang"], None, PermissionStance::AcceptEdits, root.path()) else { return };
    silent.timeouts.turn_inactivity = Duration::from_secs(2);
    silent.timeouts.turn = Duration::from_secs(60);
    let actor = SessionActor::open(silent).await.expect("attached");
    let mut subscription = actor.subscribe();
    actor.submit_text("r1", "do it").await.expect("submitted");
    let events = collect(&mut subscription, Duration::from_secs(8), |event| matches!(event, SessionEvent::Turn(thingmaker_supervisor::supervisor::TurnEffect::Settled { .. }))).await;
    let settled = events.iter().find_map(|event| match event {
        SessionEvent::Turn(thingmaker_supervisor::supervisor::TurnEffect::Settled { phase, error, .. }) => Some((*phase, error.clone())),
        _ => None,
    });
    let (phase, error) = settled.expect("a quiet turn settles");
    assert!(matches!(phase, thingmaker_supervisor::supervisor::TurnPhase::Failed | thingmaker_supervisor::supervisor::TurnPhase::Cancelled), "{phase:?}");
    if phase == thingmaker_supervisor::supervisor::TurnPhase::Failed {
        assert!(error.unwrap_or_default().contains("no progress"));
    }
    let _ = actor.stop().await;

    let Some(mut waiting) = config(&["--hang-in-tool"], None, PermissionStance::AcceptEdits, root.path()) else { return };
    waiting.timeouts.turn_inactivity = Duration::from_secs(2);
    waiting.timeouts.turn = Duration::from_secs(60);
    let actor = SessionActor::open(waiting).await.expect("attached");
    let mut subscription = actor.subscribe();
    actor.submit_text("r1", "await the team").await.expect("submitted");
    // Five seconds, well past the two-second window, and still running.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, subscription.recv()).await {
        assert!(
            !matches!(event.payload, SessionEvent::Turn(thingmaker_supervisor::supervisor::TurnEffect::Settled { .. })),
            "a turn waiting in a tool call is still running: {:?}",
            event.payload
        );
    }
    assert!(actor.snapshot().await.unwrap().foreground.is_active());
    let _ = actor.stop().await;
}
