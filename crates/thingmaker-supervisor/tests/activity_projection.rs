//! Exercise the observer with the actual Claude, Codex and Gemini bridges.
//! The programs are captured protocol fixtures; no account or provider calls.
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use thingmaker_supervisor::{
    acp::LaunchTarget,
    activity::ActivityService,
    agents::{
        Provider, claude::launch::ClaudeLaunchOptions, codex::CodexLaunchOptions,
        gemini::GeminiLaunchOptions,
    },
    storage::Storage,
    supervisor::{AgentLaunch, SessionActor, SessionActorConfig},
};

#[tokio::test]
async fn every_provider_is_observed_without_opening_a_renderer_and_detaches_cleanly() {
    for provider in [Provider::Claude, Provider::Codex, Provider::Gemini] {
        let root = tempfile::tempdir().unwrap();
        let root_path = root.path().canonicalize().unwrap();
        let python = PathBuf::from("python3");
        let fixture = match provider {
            Provider::Claude => "mock-claude-acp.py",
            Provider::Codex => "mock-codex-app-server.py",
            Provider::Gemini => "mock-agy.py",
        };
        let mock = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/test-fixtures/acp")
            .join(fixture)
            .canonicalize()
            .unwrap();
        let launch = match provider {
            Provider::Claude => AgentLaunch::Claude(ClaudeLaunchOptions::new(
                &root_path,
                python.clone(),
                vec![mock.to_string_lossy().into_owned()],
            )),
            Provider::Codex => {
                AgentLaunch::Codex(CodexLaunchOptions::new(&root_path, python.clone()))
            }
            Provider::Gemini => {
                AgentLaunch::Gemini(GeminiLaunchOptions::new(&root_path, python.clone()))
            }
        };
        let target = if provider == Provider::Claude {
            LaunchTarget::executable(python)
        } else {
            LaunchTarget {
                executable: python,
                prefix_args: vec![mock.to_string_lossy().into_owned()],
            }
        };
        let mut config = SessionActorConfig::new(target, launch);
        config.timeouts.turn = Duration::from_secs(10);
        let actor = SessionActor::open(config).await.unwrap();
        let db = Storage::open_in_memory().unwrap();
        db.workspace_upsert(
            root_path.to_str().unwrap(),
            root_path.to_str().unwrap(),
            "test",
        )
        .unwrap();
        let storage = Arc::new(Mutex::new(db));
        let service = ActivityService::new(Arc::clone(&storage));
        service.observe(actor.clone(), root_path.clone());
        tokio::time::timeout(Duration::from_secs(5), async {
            while service.snapshot().actors.is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        actor
            .submit_text("r1", "Explain this project")
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let snapshot = service.snapshot();
                let root = snapshot.actors.iter().find(|a| !a.native).unwrap();
                if root.status == "idle"
                    && root.operation == "idle"
                    && snapshot.revision.parse::<u64>().unwrap() > 3
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let snapshot = service.snapshot();
        if provider == Provider::Gemini {
            assert_eq!(
                snapshot.files.len(),
                1,
                "Gemini's TargetFile is structured evidence"
            );
            assert!(snapshot.files[0].path.ends_with("hello.txt"));
            assert!(snapshot.files[0].touched_at > 0);
            assert!(snapshot.files[0].active_actors.is_empty());
        } else {
            assert!(
                snapshot.files.is_empty(),
                "spawn and shell prose must not invent files"
            );
            let child = snapshot.actors.iter().find(|a| a.native).unwrap();
            assert_eq!(
                child.status,
                if provider == Provider::Codex {
                    "unknown"
                } else {
                    "idle"
                }
            );
        }
        let touched = snapshot.files.first().map(|f| f.touched_at);
        service.remove(&actor.handle().id);
        tokio::task::yield_now().await;
        assert!(service.snapshot().actors.is_empty());
        assert_eq!(
            Arc::strong_count(&service),
            1,
            "aborting observation releases its service ownership"
        );
        let replay = ActivityService::new(storage);
        replay.observe(actor.clone(), root_path);
        tokio::time::timeout(Duration::from_secs(5), async {
            while replay.snapshot().revision.parse::<u64>().unwrap() < 3 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            replay.snapshot().files.first().map(|f| f.touched_at),
            touched,
            "replay preserves confirmed recency"
        );
        let _ = actor.stop().await;
        tokio::time::timeout(Duration::from_secs(5), async {
            while !replay.snapshot().actors.is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
}
