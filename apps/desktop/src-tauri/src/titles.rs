//! Keeps every session's title in its record, so it survives the session
//! closing.
//!
//! A live session's title came off its stream (the first prompt) and nothing
//! kept it: once the session was no longer attached, after a restart or when
//! a worker closed, the sidebar was left with "Session a863…". Now:
//!
//! - while a session is attached, its first prompt is kept as soon as it is
//!   seen, and the provider's own title (Claude Code's `ai-title`, Codex's
//!   thread name; see `agents::titles`) replaces it when a turn ends and one
//!   has appeared;
//! - a session that was never seen with a title is given one from the
//!   provider's records the first time the records are listed (`backfill`).
//!
//! The person's own rename (`title_overlay`) always wins and is never
//! touched here.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use thingmaker_supervisor::{
    agents::{Provider, titles},
    acp::{SessionUpdate, updates::ContentBlock},
    storage::{Storage, workspaces::SessionRecord},
    supervisor::{SessionActor, SessionEvent, TurnEffect, TurnKind},
};

/// Tells the window a session's kept title changed.
pub const SESSION_TITLE_EVENT: &str = "thingmaker://session-title";

/// How often a running session's transcript is read again for a newer
/// provider title. Claude Code writes its title after the first turn and may
/// revise it; reading a long transcript on every turn would be waste.
const RECHECK: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleChange {
    pub agent_session_id: String,
    pub title: String,
}

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Lets kept titles reach the window. Called once in `setup`.
pub fn set_app(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

/// Records a title; says so to the window when it is a new, real one.
fn keep(storage: &Mutex<Storage>, agent_session_id: &str, title: &str) {
    let changed = storage.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).session_set_auto_title(agent_session_id, title).unwrap_or(false);
    if changed
        && !title.is_empty()
        && let Some(app) = APP.get()
    {
        let _ = app.emit(SESSION_TITLE_EVENT, TitleChange { agent_session_id: agent_session_id.to_string(), title: title.to_string() });
    }
}

/// The provider's title for a session, read off the async runtime.
async fn provider_title(provider: Provider, home: PathBuf, root: PathBuf, agent_session_id: String) -> Option<String> {
    tokio::task::spawn_blocking(move || titles::provider_title(provider, &home, &root, &agent_session_id)).await.ok().flatten()
}

/// Watches one live session for its title, for as long as it is attached.
pub fn observe(storage: Arc<Mutex<Storage>>, home: Option<PathBuf>, actor: SessionActor, agent_session_id: String, root: PathBuf) {
    let mut events = actor.subscribe();
    tokio::spawn(async move {
        let Ok(snapshot) = actor.snapshot().await else { return };
        let provider = snapshot.provider;
        let kept = storage
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .session_by_agent_id_anywhere(&agent_session_id)
            .ok()
            .flatten()
            .and_then(|record| record.auto_title)
            .filter(|title| !title.is_empty());
        let mut have = kept;
        let mut checked: Option<Instant> = None;
        while let Some(envelope) = events.recv().await {
            match &envelope.payload {
                SessionEvent::Update(SessionUpdate::UserMessage(message)) if have.is_none() => {
                    let text = message.content.iter().find_map(|block| match block {
                        ContentBlock::Text { text } if !text.trim_start().starts_with('<') => Some(text.as_str()),
                        _ => None,
                    });
                    if let Some(title) = text.and_then(titles::title_from_prompt) {
                        keep(&storage, &agent_session_id, &title);
                        have = Some(title);
                    }
                }
                SessionEvent::Update(SessionUpdate::SessionInfo(info)) if info.title_present => {
                    if let Some(title) = info.title.as_deref().map(str::trim).filter(|title| !title.is_empty()) {
                        keep(&storage, &agent_session_id, title);
                        have = Some(title.to_string());
                    }
                }
                // A prompt title is a stand-in until the provider names the
                // session, which it does after a turn: look on the first
                // settle, then at most every RECHECK.
                SessionEvent::Turn(TurnEffect::Settled { kind: TurnKind::Foreground, .. }) => {
                    if checked.is_some_and(|at| at.elapsed() < RECHECK) {
                        continue;
                    }
                    checked = Some(Instant::now());
                    let Some(home) = home.clone() else { continue };
                    if let Some(title) = provider_title(provider, home, root.clone(), agent_session_id.clone()).await
                        && have.as_deref() != Some(title.as_str())
                    {
                        keep(&storage, &agent_session_id, &title);
                        have = Some(title);
                    }
                }
                SessionEvent::Exited(_) => break,
                _ => {}
            }
        }
    });
}

/// Gives every listed session that has neither a rename nor a kept title one
/// from its provider's records, once: a session with none on record is
/// marked looked-for (`""`) so it is not read again.
pub fn backfill(storage: &Mutex<Storage>, home: &Path, root: &Path, records: &mut [SessionRecord]) {
    for record in records.iter_mut().filter(|record| record.title_overlay.is_none() && record.auto_title.is_none()) {
        let title = titles::provider_title(record.provider, home, root, &record.agent_session_id).unwrap_or_default();
        keep(storage, &record.agent_session_id, &title);
        record.auto_title = Some(title);
    }
}

#[cfg(test)]
mod tests {
    use thingmaker_supervisor::{
        agents::claude::transcript_usage::transcript_path,
        storage::workspaces::SessionOrigin,
    };

    use super::*;

    #[test]
    fn a_session_that_lost_its_title_gets_its_providers_back_once() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let root = dir.path().join("Undercover");
        let storage = Mutex::new(Storage::open(&dir.path().join("t.db")).unwrap());
        let workspace = storage.lock().unwrap().workspace_upsert(&root.to_string_lossy(), &root.to_string_lossy(), "w").unwrap();
        for id in ["a863adcb", "gone", "named"] {
            storage.lock().unwrap().session_upsert(&workspace.id, id, SessionOrigin::Desktop, Provider::Claude).unwrap();
        }
        let named = storage.lock().unwrap().session_by_agent_id(&workspace.id, "named").unwrap().unwrap();
        storage.lock().unwrap().session_set_title_overlay(&named.id, Some("My name")).unwrap();
        let transcript = transcript_path(&home, &root, "a863adcb");
        std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        std::fs::write(
            &transcript,
            "{\"type\":\"user\",\"message\":{\"content\":\"I'd like a quick loading screen\"}}\n{\"type\":\"ai-title\",\"aiTitle\":\"Game loading screen with chibi animation\"}\n",
        )
        .unwrap();

        let mut records = storage.lock().unwrap().session_list(&workspace.id).unwrap();
        backfill(&storage, &home, &root, &mut records);
        let title = |id: &str| records.iter().find(|record| record.agent_session_id == id).and_then(|record| record.auto_title.clone());
        assert_eq!(title("a863adcb").as_deref(), Some("Game loading screen with chibi animation"));
        assert_eq!(title("gone").as_deref(), Some(""), "a session the provider no longer has is marked looked-for");
        assert_eq!(title("named"), None, "a renamed session is left alone");

        // Kept: listing again reads nothing, even with the transcript gone.
        std::fs::remove_file(&transcript).unwrap();
        let mut again = storage.lock().unwrap().session_list(&workspace.id).unwrap();
        backfill(&storage, &home, &root, &mut again);
        assert_eq!(again.iter().find(|record| record.agent_session_id == "a863adcb").and_then(|record| record.auto_title.as_deref()), Some("Game loading screen with chibi animation"));
    }

    #[tokio::test]
    async fn a_running_sessions_first_prompt_is_kept_as_it_is_sent() {
        use thingmaker_supervisor::{
            acp::LaunchTarget,
            agents::{PermissionStance, claude::launch::ClaudeLaunchOptions},
            supervisor::{AgentLaunch, SessionActorConfig},
        };
        let Ok(python) = which_python() else {
            eprintln!("python is not available; skipping");
            return;
        };
        let mock = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/test-fixtures/acp/mock-claude-acp.py").canonicalize().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let storage = Arc::new(Mutex::new(Storage::open(&dir.path().join("t.db")).unwrap()));
        let workspace = storage.lock().unwrap().workspace_upsert("/w", "/w", "w").unwrap();
        // The id the mock hands out for every session.
        let agent_id = "d847b2a3-c7b5-4459-8b0f-02fdd03031a4";
        storage.lock().unwrap().session_upsert(&workspace.id, agent_id, SessionOrigin::Desktop, Provider::Claude).unwrap();

        let mut options = ClaudeLaunchOptions::new(dir.path(), python.clone(), vec![mock.to_string_lossy().into_owned()]);
        options.permission_mode = PermissionStance::AcceptEdits;
        let config = SessionActorConfig::new(LaunchTarget::executable(python), AgentLaunch::Claude(options));
        let actor = SessionActor::open(config).await.expect("attached");
        // No home: there is no provider title to find, so the prompt's stays.
        observe(Arc::clone(&storage), None, actor.clone(), agent_id.into(), dir.path().to_path_buf());
        actor.submit_text("r1", "## Fix the loading screen, please\nand keep it short").await.expect("sent");

        let kept = async {
            loop {
                let title = storage.lock().unwrap().session_by_agent_id_anywhere(agent_id).unwrap().and_then(|record| record.auto_title);
                if title.is_some() {
                    return title;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };
        let title = tokio::time::timeout(Duration::from_secs(10), kept).await.expect("a title is kept");
        assert_eq!(title.as_deref(), Some("Fix the loading screen, please"));
        let _ = actor.stop().await;
    }

    fn which_python() -> Result<PathBuf, ()> {
        ["python3", "python"]
            .into_iter()
            .find(|candidate| std::process::Command::new(candidate).arg("--version").output().is_ok_and(|output| output.status.success()))
            .map(PathBuf::from)
            .ok_or(())
    }
}
