//! The Codex bridge against the real `codex app-server`, on the user's own
//! ChatGPT plan. Opening a thread spends nothing; the one turn spends a few
//! tokens, so the test only runs when asked:
//!
//! ```text
//! THINGMAKER_REAL_CODEX=1 cargo test -p thingmaker-supervisor --test real_codex -- --nocapture
//! ```
//!
//! Read-only, in a scratch directory, with the app's environment profile.
//! `THINGMAKER_CODEX` names the binary; otherwise the one the ChatGPT app ships.

use std::{path::PathBuf, time::Duration};

use thingmaker_supervisor::{
    acp::{LaunchTarget, SessionUpdate, updates::ContentBlock},
    agents::{PermissionStance, codex::CodexLaunchOptions},
    supervisor::{AgentLaunch, Provider, SessionActor, SessionActorConfig, SessionEvent, TurnEffect, TurnPhase},
};

fn codex() -> PathBuf {
    std::env::var_os("THINGMAKER_CODEX")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"))
}

#[tokio::test]
async fn a_thread_opens_and_one_real_turn_streams_settles_and_counts() {
    if std::env::var("THINGMAKER_REAL_CODEX").as_deref() != Ok("1") {
        eprintln!("set THINGMAKER_REAL_CODEX=1 to spend a real turn; skipping");
        return;
    }
    let program = codex();
    let scratch = tempfile::tempdir().unwrap();
    let mut options = CodexLaunchOptions::new(scratch.path(), program.clone());
    options.permission_mode = PermissionStance::ReadOnly;
    options.model = Some(std::env::var("THINGMAKER_REAL_CODEX_MODEL").unwrap_or_else(|_| "gpt-6-luna".into()));
    options.effort = Some("low".into());
    let config = SessionActorConfig::new(LaunchTarget::executable(program), AgentLaunch::Codex(options));
    let actor = SessionActor::open(config).await.expect("attached");
    let snapshot = actor.snapshot().await.unwrap();
    let capabilities = snapshot.capabilities.clone().unwrap();
    eprintln!("agent {} {} · thread {:?}", capabilities.agent_name, capabilities.agent_version, snapshot.agent_session_id);
    assert_eq!(snapshot.provider, Provider::Codex);
    assert!(capabilities.supports_steering);
    let options = snapshot.config_options.as_array().expect("config options").clone();
    let current = |id: &str| options.iter().find(|o| o["id"] == id).and_then(|o| o["currentValue"].as_str().map(str::to_string));
    eprintln!("model {:?} · effort {:?} · mode {:?}", current("model"), current("effort"), current("mode"));
    assert_eq!(current("mode").as_deref(), Some("read-only"));
    assert!(current("model").is_some());

    let mut subscription = actor.subscribe();
    actor.submit_text("r1", "Reply with exactly the word OK and nothing else. Do not run any commands.").await.expect("submitted");
    let (mut text, mut quota, mut usage, mut settled) = (String::new(), None, None, None);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    while settled.is_none() {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let Ok(Some(event)) = tokio::time::timeout(remaining, subscription.recv()).await else {
            panic!("no settle within 180 s; text so far {text:?}");
        };
        match &event.payload {
            SessionEvent::Update(SessionUpdate::AgentMessage(message)) => {
                let chunk: String = message.content.iter().filter_map(|block| if let ContentBlock::Text { text } = block { Some(text.as_str()) } else { None }).collect();
                if message.replace {
                    text = chunk;
                } else {
                    text.push_str(&chunk);
                }
            }
            SessionEvent::Update(SessionUpdate::Usage(update)) if update.used.is_some() => usage = Some((update.used, update.size)),
            SessionEvent::Quota(snapshot) => quota = Some(snapshot.clone()),
            SessionEvent::Turn(TurnEffect::Settled { phase, stop_reason, error, .. }) => settled = Some((*phase, stop_reason.clone(), error.clone())),
            SessionEvent::Diagnostic { text } => eprintln!("diagnostic: {text}"),
            _ => {}
        }
    }
    eprintln!("reply {text:?} · settled {settled:?} · context {usage:?} · quota {quota:?}");
    let (phase, _, error) = settled.unwrap();
    assert_eq!(phase, TurnPhase::Succeeded, "turn failed: {error:?}");
    assert!(text.to_ascii_uppercase().contains("OK"), "reply was {text:?}");

    let thread = snapshot.agent_session_id.clone().unwrap();
    let _ = actor.stop().await;
    let home = PathBuf::from(std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap()).join(".codex");
    match thingmaker_supervisor::agents::codex::transcript_usage::find_rollout(&home, &thread) {
        Some(path) => {
            let usage = thingmaker_supervisor::agents::codex::transcript_usage::read_transcript_usage(&path).unwrap();
            eprintln!("rollout {} · calls {} · input {} · cached {} · output {}", path.display(), usage.totals.calls, usage.totals.input_tokens, usage.totals.cached_input_tokens, usage.totals.output_tokens);
            assert!(usage.totals.calls >= 1);
        }
        None => panic!("no rollout for thread {thread}"),
    }
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

/// `thread/fork` through the bridge: the copy knows the main thread.
#[tokio::test]
async fn a_forked_thread_remembers_the_main_one() {
    if std::env::var("THINGMAKER_REAL_CODEX").as_deref() != Ok("1") {
        eprintln!("set THINGMAKER_REAL_CODEX=1 to spend real turns; skipping");
        return;
    }
    let program = codex();
    let scratch = tempfile::tempdir().unwrap();
    let launch = || {
        let mut options = CodexLaunchOptions::new(scratch.path(), program.clone());
        options.permission_mode = PermissionStance::ReadOnly;
        options.model = Some(std::env::var("THINGMAKER_REAL_CODEX_MODEL").unwrap_or_else(|_| "gpt-6-luna".into()));
        options.effort = Some("low".into());
        SessionActorConfig::new(LaunchTarget::executable(program.clone()), AgentLaunch::Codex(options))
    };
    let main = SessionActor::open(launch()).await.expect("main attached");
    answer(&main, "m1", "Remember this code word: HERON-17. Reply with exactly OK. Do not run any commands.").await;
    let source = main.snapshot().await.unwrap().agent_session_id.expect("a thread id");
    let mut config = launch();
    config.fork_from = Some(source.clone());
    let side = SessionActor::open(config).await.expect("forked");
    let side_id = side.snapshot().await.unwrap().agent_session_id.expect("the fork has an id");
    assert_ne!(side_id, source);
    let recalled = answer(&side, "s1", "What was the code word I asked you to remember? Reply with the code word only. Do not run any commands.").await;
    eprintln!("fork {side_id} recalled {recalled:?}");
    assert!(recalled.contains("HERON-17"), "the fork did not have the main thread: {recalled:?}");
    let _ = side.stop().await;
    let _ = main.stop().await;
}

