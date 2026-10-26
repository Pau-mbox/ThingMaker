//! One real turn against the installed `claude-agent-acp`, on the user's own
//! Claude subscription. Spends a few tokens, so it only runs when asked:
//!
//! ```text
//! THINGMAKER_REAL_CLAUDE=1 cargo test -p thingmaker-supervisor --test real_claude -- --nocapture
//! ```
//!
//! It runs read-only (`plan` mode) in a scratch directory, with the same
//! environment profile the app uses — every `ANTHROPIC_*`/`CLAUDE_*` variable
//! of the shell running the test is dropped, so the account is the one Claude
//! Code itself is signed into.

use std::time::Duration;

use thingmaker_supervisor::{
    acp::{LaunchTarget, SessionUpdate, updates::ContentBlock},
    agents::{PermissionStance, claude::launch::{ClaudeLaunchOptions, locate_adapter}},
    supervisor::{AgentLaunch, SessionActor, SessionActorConfig, SessionEvent, TurnEffect, TurnPhase},
};

#[tokio::test]
async fn one_real_turn_streams_text_settles_and_reports_quota() {
    if std::env::var("THINGMAKER_REAL_CLAUDE").as_deref() != Ok("1") {
        eprintln!("set THINGMAKER_REAL_CLAUDE=1 to spend a real turn; skipping");
        return;
    }
    let home = std::path::PathBuf::from(std::env::var("HOME").expect("HOME"));
    let (node, script) = locate_adapter(&home, None, std::env::var("THINGMAKER_CLAUDE_ACP").ok()).expect("claude-agent-acp is installed");
    let scratch = tempfile::tempdir().unwrap();
    let mut options = ClaudeLaunchOptions::new(scratch.path(), node.clone(), vec![script.to_string_lossy().into_owned()]);
    options.permission_mode = PermissionStance::ReadOnly;
    options.model = std::env::var("THINGMAKER_REAL_CLAUDE_MODEL").ok().or_else(|| Some("sonnet".into()));
    options.effort = Some("low".into());
    let config = SessionActorConfig::new(LaunchTarget::executable(node), AgentLaunch::Claude(options));
    let actor = SessionActor::open(config).await.expect("attached");
    let snapshot = actor.snapshot().await.unwrap();
    eprintln!("agent {} {} · session {:?} · steering {}", snapshot.capabilities.as_ref().unwrap().agent_name, snapshot.capabilities.as_ref().unwrap().agent_version, snapshot.agent_session_id, snapshot.capabilities.as_ref().unwrap().supports_steering);

    let mut subscription = actor.subscribe();
    actor.submit_text("r1", "Reply with exactly the word OK and nothing else. Do not use any tools.").await.expect("submitted");
    let mut text = String::new();
    let mut quota = None;
    let mut settled = None;
    let mut order: Vec<&'static str> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    while settled.is_none() {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let Ok(Some(event)) = tokio::time::timeout(remaining, subscription.recv()).await else {
            panic!("no settle within 180 s; text so far {text:?}");
        };
        match &event.payload {
            SessionEvent::Update(SessionUpdate::UserMessage(_)) => order.push("user"),
            SessionEvent::Update(SessionUpdate::AgentMessage(message)) => {
                order.push("agent");
                assert!(!message.message_id.is_empty(), "every message has an id");
                for block in &message.content {
                    if let ContentBlock::Text { text: chunk } = block {
                        text.push_str(chunk);
                    }
                }
            }
            SessionEvent::Quota(snapshot) => quota = Some(snapshot.clone()),
            SessionEvent::Turn(TurnEffect::Settled { phase, stop_reason, error, .. }) => settled = Some((*phase, stop_reason.clone(), error.clone())),
            SessionEvent::Diagnostic { text } if text.contains("rror") => eprintln!("diagnostic: {text}"),
            _ => {}
        }
    }
    eprintln!("reply {text:?} · settled {settled:?} · quota {quota:?} · order {order:?}");
    // The prompt shows once, before the reply, however late the adapter
    // echoes it.
    assert_eq!(order.iter().filter(|kind| **kind == "user").count(), 1, "{order:?}");
    assert_eq!(order.first(), Some(&"user"), "{order:?}");
    let (phase, _, error) = settled.unwrap();
    assert_eq!(phase, TurnPhase::Succeeded, "turn failed: {error:?}");
    assert!(text.to_ascii_uppercase().contains("OK"), "reply was {text:?}");
    let _ = actor.stop().await;
}

/// A resumed session keeps its model and effort pickers: the adapter answers
/// `session/load` with its config options, and they reach the snapshot.
#[tokio::test]
async fn a_resumed_session_still_offers_its_config_options() {
    if std::env::var("THINGMAKER_REAL_CLAUDE").as_deref() != Ok("1") {
        eprintln!("set THINGMAKER_REAL_CLAUDE=1 to spend a real turn; skipping");
        return;
    }
    let home = std::path::PathBuf::from(std::env::var("HOME").expect("HOME"));
    let (node, script) = locate_adapter(&home, None, std::env::var("THINGMAKER_CLAUDE_ACP").ok()).expect("claude-agent-acp is installed");
    let scratch = tempfile::tempdir().unwrap();
    let launch = |resume: Option<String>| {
        let mut options = ClaudeLaunchOptions::new(scratch.path(), node.clone(), vec![script.to_string_lossy().into_owned()]);
        options.permission_mode = PermissionStance::ReadOnly;
        options.model = Some("sonnet".into());
        options.effort = Some("low".into());
        options.resume = resume;
        SessionActorConfig::new(LaunchTarget::executable(node.clone()), AgentLaunch::Claude(options))
    };
    let ids = |value: &serde_json::Value| -> Vec<String> { value.as_array().into_iter().flatten().filter_map(|o| o["id"].as_str().map(str::to_string)).collect() };
    let actor = SessionActor::open(launch(None)).await.expect("attached");
    let first = actor.snapshot().await.unwrap();
    eprintln!("new: options {:?}", ids(&first.config_options));
    let mut subscription = actor.subscribe();
    actor.submit_text("r1", "Reply with exactly the word OK. Do not use any tools.").await.expect("submitted");
    loop {
        let event = tokio::time::timeout(Duration::from_secs(120), subscription.recv()).await.expect("settles").expect("stream");
        if matches!(event.payload, SessionEvent::Turn(TurnEffect::Settled { .. })) {
            break;
        }
    }
    let id = first.agent_session_id.clone().unwrap();
    let _ = actor.stop().await;

    let resumed = SessionActor::open(launch(Some(id))).await.expect("resumed");
    tokio::time::sleep(Duration::from_secs(2)).await;
    let snapshot = resumed.snapshot().await.unwrap();
    let options = ids(&snapshot.config_options);
    eprintln!("resumed: options {options:?} · raw {}", serde_json::to_string(&snapshot.config_options).unwrap().chars().take(400).collect::<String>());
    let _ = resumed.stop().await;
    assert!(options.contains(&"model".to_string()), "resumed session lost its model option");
}

/// The account's plan usage, from Claude Code's own `/usage` data. Spends no
/// tokens: no model is called.
#[test]
fn the_accounts_usage_is_read_from_claude_code() {
    if std::env::var("THINGMAKER_REAL_CLAUDE").as_deref() != Ok("1") {
        eprintln!("set THINGMAKER_REAL_CLAUDE=1 to ask the real Claude Code; skipping");
        return;
    }
    use thingmaker_supervisor::agents::claude::usage_probe;
    let home = std::path::PathBuf::from(std::env::var("HOME").expect("HOME"));
    let (_, script) = locate_adapter(&home, None, std::env::var("THINGMAKER_CLAUDE_ACP").ok()).expect("claude-agent-acp is installed");
    let binary = usage_probe::locate_claude_binary(&script, &home).expect("Claude Code beside the adapter");
    let quota = usage_probe::read_quota(&binary, Duration::from_secs(30)).expect("a reading");
    eprintln!("{} · {:?} · {:?}", binary.display(), quota.plan, quota.windows);
    assert!(quota.windows.iter().any(|window| window.kind == "five_hour" && window.used_percent.is_some()));
}

/// What a shell command's result looks like on Claude Code's stream: the
/// shape Big Thing reads a check's exit code from. Spends one small turn.
#[tokio::test]
async fn a_shell_commands_result_carries_what_a_check_needs() {
    if std::env::var("THINGMAKER_REAL_CLAUDE").as_deref() != Ok("1") {
        eprintln!("set THINGMAKER_REAL_CLAUDE=1 to spend a real turn; skipping");
        return;
    }
    let home = std::path::PathBuf::from(std::env::var("HOME").expect("HOME"));
    let (node, script) = locate_adapter(&home, None, std::env::var("THINGMAKER_CLAUDE_ACP").ok()).expect("claude-agent-acp is installed");
    let scratch = tempfile::tempdir().unwrap();
    let mut options = ClaudeLaunchOptions::new(scratch.path(), node.clone(), vec![script.to_string_lossy().into_owned()]);
    options.permission_mode = PermissionStance::AcceptEdits;
    options.model = Some("haiku".into());
    let actor = SessionActor::open(SessionActorConfig::new(LaunchTarget::executable(node), AgentLaunch::Claude(options))).await.expect("attached");
    let mut subscription = actor.subscribe();
    actor
        .submit_text("r1", "Run exactly these two shell commands with your Bash tool, one call each, then reply OK: `echo pass-marker` and `sh -c 'echo fail-marker; exit 3'`.")
        .await
        .expect("submitted");
    loop {
        let event = tokio::time::timeout(Duration::from_secs(180), subscription.recv()).await.expect("settles").expect("stream");
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

/// The text of one turn's answer, once it settles.
async fn answer(actor: &SessionActor, request: &str, prompt: &str) -> String {
    let mut subscription = actor.subscribe();
    actor.submit_text(request, prompt).await.expect("submitted");
    let mut text = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let Ok(Some(event)) = tokio::time::timeout(remaining, subscription.recv()).await else {
            panic!("no settle within 180 s; text so far {text:?}");
        };
        match &event.payload {
            SessionEvent::Update(SessionUpdate::AgentMessage(message)) => {
                // A full message replaces the pieces streamed before it.
                if message.replace {
                    text.clear();
                }
                for block in &message.content {
                    if let ContentBlock::Text { text: chunk } = block {
                        text.push_str(chunk);
                    }
                }
            }
            SessionEvent::Turn(TurnEffect::Settled { phase, error, .. }) => {
                assert_eq!(*phase, TurnPhase::Succeeded, "turn failed: {error:?}");
                return text;
            }
            _ => {}
        }
    }
}

/// The Side Transcript's premise: a fork made by another adapter process
/// knows the main conversation, and the main session knows nothing of it.
#[tokio::test]
async fn a_fork_remembers_the_main_conversation_and_the_main_session_is_untouched() {
    if std::env::var("THINGMAKER_REAL_CLAUDE").as_deref() != Ok("1") {
        eprintln!("set THINGMAKER_REAL_CLAUDE=1 to spend real turns; skipping");
        return;
    }
    let home = std::path::PathBuf::from(std::env::var("HOME").expect("HOME"));
    let (node, script) = locate_adapter(&home, None, std::env::var("THINGMAKER_CLAUDE_ACP").ok()).expect("claude-agent-acp is installed");
    let scratch = tempfile::tempdir().unwrap();
    let launch = || {
        let mut options = ClaudeLaunchOptions::new(scratch.path(), node.clone(), vec![script.to_string_lossy().into_owned()]);
        options.permission_mode = PermissionStance::ReadOnly;
        options.model = std::env::var("THINGMAKER_REAL_CLAUDE_MODEL").ok().or_else(|| Some("sonnet".into()));
        options.effort = Some("low".into());
        SessionActorConfig::new(LaunchTarget::executable(node.clone()), AgentLaunch::Claude(options))
    };
    let main = SessionActor::open(launch()).await.expect("main attached");
    let said = answer(&main, "m1", "Remember this code word: PELICAN-42. Reply with exactly OK. Do not use any tools.").await;
    assert!(said.to_ascii_uppercase().contains("OK"), "{said:?}");
    let source = main.snapshot().await.unwrap().agent_session_id.expect("the main session has an id");

    let mut config = launch();
    config.fork_from = Some(source.clone());
    let side = SessionActor::open(config).await.expect("forked");
    let side_id = side.snapshot().await.unwrap().agent_session_id.expect("the fork has an id");
    assert_ne!(side_id, source, "the fork is a session of its own");
    let recalled = answer(&side, "s1", "What was the code word I asked you to remember? Reply with the code word only. Do not use any tools.").await;
    eprintln!("fork {side_id} recalled {recalled:?}");
    assert!(recalled.contains("PELICAN-42"), "the fork did not have the main conversation: {recalled:?}");

    // The main conversation did not grow from the side's turn.
    let main_texts: Vec<String> = main.history(0, 10_000).await.unwrap().iter().filter_map(|event| match &event.payload {
        SessionEvent::Update(SessionUpdate::UserMessage(message)) => message.content.iter().find_map(|block| if let ContentBlock::Text { text } = block { Some(text.clone()) } else { None }),
        _ => None,
    }).collect();
    assert!(main_texts.iter().all(|text| !text.contains("What was the code word")), "{main_texts:?}");
    let _ = side.stop().await;
    let _ = main.stop().await;
}

/// A command Claude Code leaves in the background is followed to its end
/// through its output file, with nothing asked of the adapter beyond ACP.
#[tokio::test]
async fn a_real_background_command_is_seen_running_and_then_ending() {
    if std::env::var("THINGMAKER_REAL_CLAUDE").as_deref() != Ok("1") {
        eprintln!("set THINGMAKER_REAL_CLAUDE=1 to spend a real turn; skipping");
        return;
    }
    let home = std::path::PathBuf::from(std::env::var("HOME").expect("HOME"));
    let (node, script) = locate_adapter(&home, None, std::env::var("THINGMAKER_CLAUDE_ACP").ok()).expect("claude-agent-acp is installed");
    let scratch = tempfile::tempdir().unwrap();
    let mut options = ClaudeLaunchOptions::new(scratch.path(), node.clone(), vec![script.to_string_lossy().into_owned()]);
    options.permission_mode = PermissionStance::AcceptEdits;
    options.model = std::env::var("THINGMAKER_REAL_CLAUDE_MODEL").ok().or_else(|| Some("sonnet".into()));
    options.effort = Some("low".into());
    let actor = SessionActor::open(SessionActorConfig::new(LaunchTarget::executable(node), AgentLaunch::Claude(options))).await.expect("attached");
    let mut subscription = actor.subscribe();
    actor
        .submit_text("b1", "Use the Bash tool with run_in_background set to true to run exactly: sleep 4 && echo BG-DONE . Do not wait for it and do not check on it. Then reply with exactly OK.")
        .await
        .expect("submitted");
    let (mut running, mut ended) = (None, None);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    while ended.is_none() {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let Ok(Some(event)) = tokio::time::timeout(remaining, subscription.recv()).await else {
            panic!("the background command was not seen ending; running {running:?}");
        };
        if let SessionEvent::BackgroundTask(task) = &event.payload {
            eprintln!("background {:?} {:?} {:?} {:?}", task.task_id, task.state, task.command, task.ending);
            if task.state == thingmaker_supervisor::supervisor::BackgroundTaskState::Running {
                running = Some(task.clone());
            } else {
                ended = Some(task.clone());
            }
        }
    }
    let running = running.expect("it was seen running first");
    assert!(running.command.as_deref().unwrap_or_default().contains("BG-DONE"), "{running:?}");
    assert!(running.output_path.is_some(), "{running:?}");
    let ended = ended.unwrap();
    assert_eq!(ended.state, thingmaker_supervisor::supervisor::BackgroundTaskState::Completed, "{ended:?}");
    assert_eq!(ended.exit_code, Some(0));
    let _ = actor.stop().await;
}

