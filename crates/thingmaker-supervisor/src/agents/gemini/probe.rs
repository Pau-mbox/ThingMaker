//! One-shot questions to `agy`: whether it is signed in, and which models
//! the account can select. `agy models` answers both and spends no tokens.
//!
//! `agy` has no status command and no headless sign-in: it shares its
//! sign-in with the Antigravity desktop app, or signs in when run once in a
//! terminal. The desktop never sees a credential.

use std::{
    collections::BTreeMap,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use crate::{
    agents::{
        Provider,
        auth::{ProviderAuthStatus, ProviderModel},
    },
    security::EnvironmentProfile,
};

/// What to tell someone who is not signed in.
pub const SIGN_IN_HINT: &str = "Sign in through the Antigravity app, or run `agy` once in a terminal and follow its sign-in.";

/// `agy models`, with a bound, in the documented environment.
pub fn read_models(program: &Path, timeout: Duration) -> Result<Vec<ProviderModel>, String> {
    let env = EnvironmentProfile::trusted_local().resolve(std::env::vars());
    read_models_with(program, &env, timeout)
}

/// `agy models` with an environment already resolved (a session's own).
pub fn read_models_with(program: &Path, env: &BTreeMap<String, String>, timeout: Duration) -> Result<Vec<ProviderModel>, String> {
    let mut child = Command::new(program)
        .arg("models")
        .current_dir(std::env::temp_dir())
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start agy: {error}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < timeout => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("agy did not list its models within {}s", timeout.as_secs()));
            }
        }
    }
    let output = child.wait_with_output().map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let models = models_from_list(&stdout);
    if models.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let reason = stderr.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("it listed no models").trim().to_string();
        return Err(format!("agy listed no models ({reason}). {SIGN_IN_HINT}"));
    }
    Ok(models)
}

/// `slug<TAB>Display name` per line, after a "Fetching…" banner.
pub fn models_from_list(text: &str) -> Vec<ProviderModel> {
    text.lines()
        .filter_map(|line| {
            let (id, name) = line.split_once('\t')?;
            let id = id.trim();
            if id.is_empty() || id.contains(' ') {
                return None;
            }
            Some(ProviderModel {
                id: id.to_string(),
                name: name.trim().to_string(),
                description: None,
                needs_credits: false,
                // Antigravity's effort is in the slug (`-high`, `-low`) and in
                // `--effort`; the slug is the one the picker offers.
                efforts: Vec::new(),
                default_effort: None,
                input_image: false,
                is_default: false,
            })
        })
        .collect()
}

/// Signed in when `agy models` answers; otherwise the reason.
pub fn read_status(program: &Path, timeout: Duration) -> ProviderAuthStatus {
    match read_models(program, timeout) {
        Ok(_) => ProviderAuthStatus { provider: Provider::Gemini, logged_in: Some(true), method: Some("google".into()), account: None, plan: None, problem: None },
        Err(error) => ProviderAuthStatus { provider: Provider::Gemini, logged_in: Some(false), method: None, account: None, plan: None, problem: Some(error) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_reads_as_agy_prints_it() {
        let models = models_from_list("Fetching available models...\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n");
        let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids, ["gemini-3.8-flash-low", "gemini-3.1-pro-high", "claude-opus-4-6-thinking"]);
        assert_eq!(models[1].name, "Gemini 3.1 Pro (High)");
        assert!(models_from_list("Fetching available models...\n").is_empty());
    }
}
