//! The installed provider programs, as the Providers panel reports them.
//!
//! Opt-in (`THINGMAKER_REAL_VERSIONS=1`): it asks each real program for its
//! version and npm for the newest adapter. Nothing is updated and no provider
//! is signed in to, so it spends no tokens.

use std::path::{Path, PathBuf};

use thingmaker_supervisor::agents::{Provider, claude, gemini, versions};

#[test]
fn the_installed_providers_report_their_versions() {
    if std::env::var("THINGMAKER_REAL_VERSIONS").as_deref() != Ok("1") {
        eprintln!("set THINGMAKER_REAL_VERSIONS=1 to ask the real programs");
        return;
    }
    let home = PathBuf::from(std::env::var("HOME").expect("HOME"));
    if let Ok((node, script)) = claude::launch::locate_adapter(&home, None, None) {
        let answer = versions::check(Provider::Claude, &node, &[script.to_string_lossy().into_owned()], true);
        eprintln!("{answer:#?}");
        assert!(answer.installed.is_some() && answer.latest.is_some() && answer.can_update, "{answer:#?}");
    }
    let codex = Path::new("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex");
    if codex.exists() {
        let answer = versions::check(Provider::Codex, codex, &[], true);
        eprintln!("{answer:#?}");
        assert!(answer.installed.is_some() && !answer.can_update && answer.how.contains("ChatGPT"), "{answer:#?}");
    }
    if let Some(agy) = gemini::launch::find_program(&home) {
        let answer = versions::check(Provider::Gemini, &agy, &[], true);
        eprintln!("{answer:#?}");
        assert!(answer.installed.is_some() && answer.can_update, "{answer:#?}");
    }
}
