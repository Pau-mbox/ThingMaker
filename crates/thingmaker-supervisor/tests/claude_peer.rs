//! The session actor against the Claude adapter.
//!
//! The mock in `packages/test-fixtures/acp/mock-claude-acp.py` answers to the
//! shape of `claude-agent-acp` 0.89.1 as captured from the real program: ACP
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
    assert_eq!(capabilities.agent_version, "0.89.1");
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
    let Some(config) = config(&["--refuse-model=fable"], None, PermissionStance::AcceptEdits, &std::env::temp_dir()) else {
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
    assert_eq!(model.as_deref(), Some("fable"));
    let _ = actor.stop().await;
}

/// The model the actor landed on.
async fn current_model(actor: &SessionActor) -> Option<String> {
    let snapshot = actor.snapshot().await.expect("snapshot");
    snapshot
        .config_options
        .as_array()
        .and_then(|options| options.iter().find(|option| option.get("id").and_then(|v| v.as_str()) == Some("model")))
        .and_then(|option| option.get("currentValue"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

#[tokio::test]
async fn a_model_the_adapter_renamed_is_selected_under_its_new_name_and_its_old_one() {
    // 0.89 lists Fable as `fable`, 0.84 as `claude-fable-5-1`. A run asking
    // for either lands on Fable under whichever adapter is installed, rather
    // than falling back to Opus because an id changed under it.
    let Some(mut config) = config(&["--legacy-ids"], None, PermissionStance::AcceptEdits, &std::env::temp_dir()) else {
        eprintln!("python is not available; skipping");
        return;
    };
    let actor = SessionActor::open(config.clone()).await.expect("attached");
    assert_eq!(current_model(&actor).await.as_deref(), Some("claude-fable-5-1"), "asked for `fable`, the 0.84 adapter has it as `claude-fable-5-1`");
    let _ = actor.stop().await;

    let Some(fresh) = self::config(&[], None, PermissionStance::AcceptEdits, &std::env::temp_dir()) else { return };
    config = fresh;
    if let AgentLaunch::Claude(options) = &mut config.launch {
        options.model = Some("claude-fable-5-1".into());
    }
    let actor = SessionActor::open(config).await.expect("attached");
    assert_eq!(current_model(&actor).await.as_deref(), Some("fable"), "a saved 0.84 id selects Fable on 0.89");
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
    assert!(last.1.starts_with("BIGTHING-REPORT"));

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

/// A steer shows in the transcript as the person's message, where it went
/// in, as a prompt does; an agent that echoes it back does not show it twice.
#[tokio::test]
async fn a_steer_is_in_the_transcript_once_even_when_the_agent_echoes_it() {
    for args in [&["--hang-in-tool"][..], &["--hang-in-tool", "--echo-steer"][..]] {
        let Some(config) = config(args, None, PermissionStance::AcceptEdits, &std::env::temp_dir()) else {
            eprintln!("python is not available; skipping");
            return;
        };
        let actor = SessionActor::open(config).await.expect("attached");
        actor.submit_text("r1", "first").await.expect("submitted");
        let outcome = actor.steer_text("also update the changelog").await.expect("a reply");
        let SteerOutcome::Accepted { message_id } = outcome else { panic!("{outcome:?}") };
        // Time for an echo to arrive, if the agent sends one.
        tokio::time::sleep(Duration::from_millis(800)).await;
        let history = actor.history(0, 1000).await.expect("history");
        let said: Vec<(String, String)> = history
            .iter()
            .filter_map(|event| match &event.payload {
                SessionEvent::Update(SessionUpdate::UserMessage(message)) => Some((
                    message.message_id.clone(),
                    message.content.iter().filter_map(|block| if let ContentBlock::Text { text } = block { Some(text.as_str()) } else { None }).collect(),
                )),
                _ => None,
            })
            .collect();
        let steers: Vec<_> = said.iter().filter(|(_, text)| text.contains("changelog")).collect();
        assert_eq!(steers.len(), 1, "{args:?}: {said:?}");
        assert_eq!(steers[0].0, message_id, "{args:?}: shown under the steer's own id");
        let _ = actor.cancel().await;
        let _ = actor.stop().await;
    }
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

// ------------------------------------------------------------------ queue

use thingmaker_supervisor::supervisor::{EnqueueOutcome, QueueOp, SubmissionState, TurnEffect, TurnPhase};

fn user_text(event: &SessionEvent, id: &str) -> bool {
    matches!(event, SessionEvent::Update(SessionUpdate::UserMessage(message)) if message.message_id == format!("prompt-{id}"))
}

fn settled(event: &SessionEvent) -> Option<TurnPhase> {
    match event {
        SessionEvent::Turn(TurnEffect::Settled { phase, .. }) => Some(*phase),
        _ => None,
    }
}

#[tokio::test]
async fn a_prompt_queued_while_a_turn_runs_goes_when_that_turn_succeeds() {
    let Some(config) = config(&["--slow=0.6", "--echo"], None, PermissionStance::AcceptEdits, &std::env::temp_dir()) else {
        eprintln!("python is not available; skipping");
        return;
    };
    let actor = SessionActor::open(config).await.expect("attached");
    let mut subscription = actor.subscribe();
    actor.submit_text("r1", "first").await.expect("submitted");
    let outcome = actor.enqueue_text("q1", "second").await.expect("queued");
    assert_eq!(outcome, EnqueueOutcome::Queued { position: 1 });

    let mut settles = 0;
    let events = collect(&mut subscription, Duration::from_secs(10), |event| {
        if settled(event).is_some() {
            settles += 1;
        }
        settles == 2
    })
    .await;

    // The queued prompt is on its way before the first turn's end is
    // published: anyone reading the stream sees no idle gap to prompt into.
    let sending = events.iter().position(|event| matches!(event, SessionEvent::Queue(queue) if queue.sending.as_deref() == Some("q1"))).expect("the queue sends q1");
    let first_settle = events.iter().position(|event| settled(event).is_some()).expect("the first turn settles");
    assert!(sending < first_settle, "the queue moved before the settle was published: {events:#?}");
    assert_eq!(settled(&events[first_settle]), Some(TurnPhase::Succeeded));

    // It ran as a turn of its own, with the user's message in the transcript.
    assert!(events.iter().any(|event| user_text(event, "q1")), "{events:#?}");
    assert!(events.iter().any(|event| matches!(event, SessionEvent::Submission { request_id, state: SubmissionState::Accepted, .. } if request_id == "q1")));
    let snapshot = actor.snapshot().await.expect("snapshot");
    assert!(snapshot.queue.items.is_empty() && snapshot.queue.sending.is_none() && snapshot.queue.paused.is_none());
    let _ = actor.stop().await;
}

#[tokio::test]
async fn a_queue_pauses_after_a_turn_that_did_not_succeed_and_resumes_when_asked() {
    let Some(config) = config(&["--slow=0.4", "--refuse-first"], None, PermissionStance::AcceptEdits, &std::env::temp_dir()) else {
        eprintln!("python is not available; skipping");
        return;
    };
    let actor = SessionActor::open(config).await.expect("attached");
    let mut subscription = actor.subscribe();
    actor.submit_text("r1", "first").await.expect("submitted");
    actor.enqueue_text("q1", "second").await.expect("queued");
    let events = collect(&mut subscription, Duration::from_secs(10), |event| settled(event).is_some()).await;
    assert!(events.iter().any(|event| settled(event) == Some(TurnPhase::Failed)), "{events:#?}");
    assert!(events.iter().any(|event| matches!(event, SessionEvent::Queue(queue) if queue.paused.as_deref() == Some("the turn failed"))), "{events:#?}");
    let snapshot = actor.snapshot().await.expect("snapshot");
    assert_eq!(snapshot.queue.items.len(), 1, "nothing was sent after the refusal");
    assert!(!snapshot.foreground.is_active());

    // Enqueueing more while paused adds to the queue; it does not send.
    assert_eq!(actor.enqueue_text("q2", "third").await.expect("queued"), EnqueueOutcome::Queued { position: 2 });

    let reply = actor.queue(QueueOp::Resume).await.expect("resumed");
    assert_eq!(reply.queue.sending.as_deref(), Some("q1"));
    let mut settles = 0;
    let events = collect(&mut subscription, Duration::from_secs(10), |event| {
        if settled(event).is_some() {
            settles += 1;
        }
        settles == 2
    })
    .await;
    assert!(events.iter().any(|event| user_text(event, "q1")) && events.iter().any(|event| user_text(event, "q2")), "both went, in order: {events:#?}");
    let first = events.iter().position(|event| user_text(event, "q1")).unwrap();
    let second = events.iter().position(|event| user_text(event, "q2")).unwrap();
    assert!(first < second);
    let _ = actor.stop().await;
}

#[tokio::test]
async fn queued_prompts_are_reordered_taken_out_and_cleared() {
    let Some(config) = config(&["--hang-in-tool"], None, PermissionStance::AcceptEdits, &std::env::temp_dir()) else {
        eprintln!("python is not available; skipping");
        return;
    };
    let actor = SessionActor::open(config).await.expect("attached");
    actor.submit_text("r1", "first").await.expect("submitted");
    for (id, text) in [("a", "one"), ("b", "two"), ("c", "three")] {
        actor.enqueue_text(id, text).await.expect("queued");
    }
    let reply = actor.queue(QueueOp::Move { id: "c".into(), index: 0 }).await.expect("moved");
    let order: Vec<&str> = reply.queue.items.iter().map(|item| item.id.as_str()).collect();
    assert_eq!(order, ["c", "a", "b"]);

    let reply = actor.queue(QueueOp::Remove { id: "a".into() }).await.expect("removed");
    assert_eq!(reply.removed.as_ref().map(|item| item.text.as_str()), Some("one"), "taken out with its text, to edit");
    assert_eq!(reply.queue.items.len(), 2);
    assert!(actor.queue(QueueOp::Remove { id: "a".into() }).await.is_err(), "it is gone");

    let reply = actor.queue(QueueOp::Clear).await.expect("cleared");
    assert!(reply.queue.items.is_empty());
    let _ = actor.cancel().await;
    let _ = actor.stop().await;
}

#[tokio::test]
async fn send_now_steers_a_queued_prompt_into_a_turn_that_can_be_steered() {
    let Some(config) = config(&["--hang-in-tool"], None, PermissionStance::AcceptEdits, &std::env::temp_dir()) else {
        eprintln!("python is not available; skipping");
        return;
    };
    let actor = SessionActor::open(config).await.expect("attached");
    let mut subscription = actor.subscribe();
    actor.submit_text("r1", "first").await.expect("submitted");
    actor.enqueue_text("q1", "look at the tests too").await.expect("queued");
    let reply = actor.queue(QueueOp::SendNow { id: "q1".into() }).await.expect("sent now");
    assert!(reply.queue.items.is_empty(), "it left the queue for the running turn");
    let events = collect(&mut subscription, Duration::from_secs(10), |event| matches!(event, SessionEvent::Steer { state: thingmaker_supervisor::supervisor::events::SteerState::Delivered, .. })).await;
    assert!(!events.iter().any(|event| matches!(event, SessionEvent::Turn(TurnEffect::Cancelling { .. }))), "nothing was cancelled");
    let _ = actor.cancel().await;
    let _ = actor.stop().await;
}

#[tokio::test]
async fn send_now_on_an_agent_that_cannot_steer_cancels_the_turn_and_goes_next() {
    let Some(config) = config(&["--hang-in-tool", "--no-steer"], None, PermissionStance::AcceptEdits, &std::env::temp_dir()) else {
        eprintln!("python is not available; skipping");
        return;
    };
    let actor = SessionActor::open(config).await.expect("attached");
    let mut subscription = actor.subscribe();
    actor.submit_text("r1", "first").await.expect("submitted");
    actor.enqueue_text("q1", "do this instead").await.expect("queued");
    actor.enqueue_text("q2", "and then this").await.expect("queued");
    actor.queue(QueueOp::SendNow { id: "q2".into() }).await.expect("sent now");
    let events = collect(&mut subscription, Duration::from_secs(10), |event| user_text(event, "q2")).await;
    assert!(events.iter().any(|event| settled(event) == Some(TurnPhase::Cancelled)), "the running turn was cancelled: {events:#?}");
    // A cancelled turn would pause the queue; "send now" is the person
    // saying what goes next, so it went, and the rest waits its turn.
    let snapshot = actor.snapshot().await.expect("snapshot");
    assert_eq!(snapshot.queue.items.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(), ["q1"]);
    let _ = actor.cancel().await;
    let _ = actor.stop().await;
}

#[tokio::test]
async fn enqueueing_into_an_idle_session_sends_at_once() {
    let Some(config) = config(&["--echo"], None, PermissionStance::AcceptEdits, &std::env::temp_dir()) else {
        eprintln!("python is not available; skipping");
        return;
    };
    let actor = SessionActor::open(config).await.expect("attached");
    let mut subscription = actor.subscribe();
    assert_eq!(actor.enqueue_text("q1", "hello").await.expect("sent"), EnqueueOutcome::Sent);
    let events = collect(&mut subscription, Duration::from_secs(10), |event| settled(event).is_some()).await;
    assert!(events.iter().any(|event| user_text(event, "q1")));
    let _ = actor.stop().await;
}

#[tokio::test]
async fn big_thing_never_sees_an_idle_session_while_the_persons_queue_is_going() {
    use thingmaker_supervisor::bigthing::watch::{Signal, Watch};
    // Big Thing prompts a session the moment its watch says it is idle. A
    // prompt the person queued must go first: at the settle that ends the
    // running turn, the watch already knows the queue is sending.
    let Some(config) = config(&["--slow=0.5"], None, PermissionStance::AcceptEdits, &std::env::temp_dir()) else {
        eprintln!("python is not available; skipping");
        return;
    };
    let actor = SessionActor::open(config).await.expect("attached");
    let (signals, mut received) = tokio::sync::mpsc::unbounded_channel();
    let watch = Watch::start(actor.clone(), Provider::Claude, signals).await;
    actor.submit_text("r1", "first").await.expect("submitted");
    actor.enqueue_text("q1", "second").await.expect("queued");

    let mut settles = 0;
    while settles < 2 {
        let signal = tokio::time::timeout(Duration::from_secs(10), received.recv()).await.expect("a signal").expect("open");
        if let Signal::Settled { .. } = signal {
            settles += 1;
            if settles == 1 {
                assert!(!watch.idle(), "the queued prompt holds the session at the first settle");
            }
        }
    }
    assert!(watch.idle(), "with the queue empty and the turn over, the session is the runner's again");
    let _ = actor.stop().await;
}
