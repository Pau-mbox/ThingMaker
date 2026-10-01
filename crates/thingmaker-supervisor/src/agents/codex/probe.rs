//! One-shot questions to `codex app-server`: who is signed in, which models
//! the account can select, and what its quota says.
//!
//! Each call starts the official program, asks over its own protocol and
//! stops it. None of these start a turn, so none of them spend tokens. The
//! desktop never sees a credential: Codex answers from its own store.

use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use serde_json::{Value, json};

use super::{launch::initialize_params, quota::quota_from_rate_limits};
use crate::{
    agents::{
        Provider,
        auth::{ProviderAuthStatus, ProviderModel},
        events::QuotaSnapshot,
    },
    security::EnvironmentProfile,
};

/// The environment Codex runs with: the documented profile, plus the
/// account's `CODEX_HOME` when it is not the default one.
pub fn environment(codex_home: Option<&Path>) -> EnvironmentProfile {
    let profile = EnvironmentProfile::trusted_local();
    match codex_home {
        Some(home) => profile.with_set("CODEX_HOME", home.to_string_lossy()),
        None => profile,
    }
}

/// Runs `codex app-server`, sends `initialize`, then each call in order, and
/// returns each call's result (or its error, as `Err`).
pub fn ask(program: &Path, codex_home: Option<&Path>, calls: &[(&str, Value)], timeout: Duration) -> Result<Vec<Result<Value, String>>, String> {
    let env = environment(codex_home).resolve(std::env::vars());
    let scratch = std::env::temp_dir();
    let mut child = Command::new(program)
        .arg("app-server")
        .current_dir(&scratch)
        .env_clear()
        .envs(&env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("could not start Codex: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("Codex took no input")?;
    let stdout = child.stdout.take().ok_or("Codex produced no output")?;
    let wanted = calls.len();
    let (tx, rx) = std::sync::mpsc::channel::<(u64, Result<Value, String>)>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
            let Some(id) = value.get("id").and_then(Value::as_u64) else { continue };
            if value.get("method").is_some() {
                continue;
            }
            let result = match value.get("error") {
                Some(error) => Err(error.get("message").and_then(Value::as_str).unwrap_or("error").to_string()),
                None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
            };
            if tx.send((id, result)).is_err() {
                break;
            }
        }
    });
    let frame = |id: u64, method: &str, params: &Value| format!("{}\n", json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
    let mut write = |text: String| stdin.write_all(text.as_bytes()).and_then(|()| stdin.flush());
    let deadline = Instant::now() + timeout;
    let finish = |mut child: std::process::Child| {
        let _ = child.kill();
        let _ = child.wait();
    };
    if write(frame(0, "initialize", &initialize_params("thingmaker", "ThingMaker", env!("CARGO_PKG_VERSION")))).is_err() {
        finish(child);
        return Err("Codex closed its input".into());
    }
    match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok((0, Ok(_))) => {}
        Ok((_, Err(error))) => {
            finish(child);
            return Err(error);
        }
        _ => {
            finish(child);
            return Err(format!("Codex did not answer within {}s", timeout.as_secs()));
        }
    }
    let _ = write(format!("{}\n", json!({"jsonrpc": "2.0", "method": "initialized"})));
    for (index, (method, params)) in calls.iter().enumerate() {
        let _ = write(frame(index as u64 + 1, method, params));
    }
    let mut results: Vec<Option<Result<Value, String>>> = vec![None; wanted];
    while results.iter().any(Option::is_none) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok((id, result)) if id >= 1 && (id as usize) <= wanted => results[id as usize - 1] = Some(result),
            Ok(_) => {}
            Err(_) => break,
        }
    }
    finish(child);
    Ok(results
        .into_iter()
        .map(|result| result.unwrap_or_else(|| Err(format!("Codex did not answer within {}s", timeout.as_secs()))))
        .collect())
}

/// Who Codex is signed in as, from `account/read`.
pub fn read_status(program: &Path, codex_home: Option<&Path>, timeout: Duration) -> ProviderAuthStatus {
    match ask(program, codex_home, &[("account/read", json!({}))], timeout) {
        Ok(mut results) => match results.remove(0) {
            Ok(value) => status_from_account(&value),
            Err(error) => ProviderAuthStatus::problem(Provider::Codex, error),
        },
        Err(error) => ProviderAuthStatus::problem(Provider::Codex, error),
    }
}

pub fn status_from_account(value: &Value) -> ProviderAuthStatus {
    let account = value.get("account").filter(|account| !account.is_null());
    ProviderAuthStatus {
        provider: Provider::Codex,
        logged_in: Some(account.is_some()),
        method: account.and_then(|account| account.get("type")).and_then(Value::as_str).map(str::to_string),
        account: account.and_then(|account| account.get("email")).and_then(Value::as_str).map(str::to_string),
        plan: account.and_then(|account| account.get("planType")).and_then(Value::as_str).map(str::to_string),
        problem: None,
    }
}

/// The models the account can select, from `model/list`.
pub fn read_models(program: &Path, codex_home: Option<&Path>, timeout: Duration) -> Result<Vec<ProviderModel>, String> {
    let mut results = ask(program, codex_home, &[("model/list", json!({"limit": 100}))], timeout)?;
    let value = results.remove(0)?;
    Ok(models_from_list(&value))
}

pub fn models_from_list(value: &Value) -> Vec<ProviderModel> {
    value
        .get("data")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter(|model| !model.get("hidden").and_then(Value::as_bool).unwrap_or(false))
                .filter_map(|model| {
                    let id = model.get("id").and_then(Value::as_str)?.to_string();
                    let efforts = model
                        .get("supportedReasoningEfforts")
                        .and_then(Value::as_array)
                        .map(|efforts| efforts.iter().filter_map(|effort| effort.get("reasoningEffort").and_then(Value::as_str).map(str::to_string)).collect())
                        .unwrap_or_default();
                    Some(ProviderModel {
                        name: model.get("displayName").and_then(Value::as_str).unwrap_or(&id).to_string(),
                        description: model.get("description").and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_string),
                        needs_credits: false,
                        efforts,
                        default_effort: model.get("defaultReasoningEffort").and_then(Value::as_str).map(str::to_string),
                        input_image: model
                            .get("inputModalities")
                            .and_then(Value::as_array)
                            .is_some_and(|modalities| modalities.iter().any(|modality| modality.as_str() == Some("image"))),
                        is_default: model.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
                        id,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The account's quota now, from `account/rateLimits/read`.
pub fn read_quota(program: &Path, codex_home: Option<&Path>, timeout: Duration) -> Result<QuotaSnapshot, String> {
    let mut results = ask(program, codex_home, &[("account/rateLimits/read", json!({}))], timeout)?;
    let value = results.remove(0)?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    value
        .get("rateLimits")
        .and_then(|limits| quota_from_rate_limits(limits, now))
        .ok_or_else(|| "Codex reported no rate-limit windows".to_string())
}

/// `codex login`: the ChatGPT sign-in, in the user's browser.
pub fn login_args() -> Vec<String> {
    vec!["login".into()]
}

/// `codex logout`: forgets the account in this `CODEX_HOME`.
pub fn logout_args() -> Vec<String> {
    vec!["logout".into()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_account_and_the_catalog_read_as_the_app_server_answers_them() {
        let status = status_from_account(&json!({"account": {"type": "chatgpt", "email": "me@example.com", "planType": "plus"}, "requiresOpenaiAuth": true}));
        assert_eq!(status.logged_in, Some(true));
        assert_eq!(status.account.as_deref(), Some("me@example.com"));
        assert_eq!(status.plan.as_deref(), Some("plus"));
        assert_eq!(status_from_account(&json!({"account": null, "requiresOpenaiAuth": true})).logged_in, Some(false));

        let models = models_from_list(&json!({"data": [
            {"id": "gpt-6-astra", "displayName": "GPT-6-Astra", "description": "", "hidden": false, "isDefault": true,
             "supportedReasoningEfforts": [{"reasoningEffort": "low"}, {"reasoningEffort": "max"}], "defaultReasoningEffort": "medium", "inputModalities": ["text", "image"]},
            {"id": "internal", "displayName": "Internal", "hidden": true}
        ]}));
        assert_eq!(models.len(), 1, "hidden models are not offered");
        assert_eq!(models[0].efforts, ["low", "max"]);
        assert!(models[0].is_default && models[0].input_image);
        assert_eq!(models[0].description, None);
    }

    #[test]
    fn a_second_account_is_a_second_codex_home() {
        let env = environment(Some(Path::new("/Users/me/.thingmaker/codex-work"))).resolve(Vec::<(String, String)>::new());
        assert_eq!(env.get("CODEX_HOME").map(String::as_str), Some("/Users/me/.thingmaker/codex-work"));
        assert!(!environment(None).resolve(vec![("CODEX_HOME".to_string(), "/elsewhere".to_string())]).contains_key("CODEX_HOME"), "a shell's CODEX_HOME never leaks in");
    }
}
