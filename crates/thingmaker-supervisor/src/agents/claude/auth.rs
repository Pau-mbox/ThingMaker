//! Sign-in and the model catalog for Claude Code, through the adapter's
//! own CLI.
//!
//! The desktop runs `claude-agent-acp --cli auth …` as a separate process and
//! never sees a token — the child writes to Claude Code's own store — and a
//! URL is surfaced for the user to click, never opened for them. Sign-in
//! completes through Anthropic's own flow, which is what the Claude Code
//! terms require of any client that is not Anthropic's.

use std::{path::PathBuf, process::Command, time::Duration};

use crate::agents::{
    Provider,
    auth::{ProviderAuthStatus, ProviderModel, run_bounded},
};

/// The CLI arguments the adapter takes, kept in one place because they are
/// the adapter's own.
pub fn status_args(profile_args: &[String]) -> Vec<String> {
    let mut args = profile_args.to_vec();
    args.extend(["--cli".into(), "auth".into(), "status".into()]);
    args
}

/// `--claudeai` is what makes the work count against a Claude *subscription*
/// rather than metered Console API billing.
/// Signs Claude Code out of its own store, so the next sign-in can be a
/// different account.
pub fn logout_args(profile_args: &[String]) -> Vec<String> {
    let mut args = profile_args.to_vec();
    args.extend(["--cli".into(), "auth".into(), "logout".into()]);
    args
}

pub fn login_args(profile_args: &[String], subscription: bool) -> Vec<String> {
    let mut args = profile_args.to_vec();
    args.extend(["--cli".into(), "auth".into(), "login".into()]);
    if subscription {
        args.push("--claudeai".into());
    }
    args
}

fn field<'a>(value: &'a serde_json::Value, keys: &[&str]) -> Option<&'a serde_json::Value> {
    keys.iter().find_map(|key| value.get(*key))
}

/// Reads Claude Code's own auth status. Read-only: it asks and reports.
pub fn read_status(executable: &PathBuf, args: &[String], timeout: Duration) -> ProviderAuthStatus {
    let problem = |text: String| ProviderAuthStatus::problem(Provider::Claude, text);
    let mut command = Command::new(executable);
    command.args(status_args(args)).stdin(std::process::Stdio::null());
    // The adapter prints JSON on stdout and Node warnings on stderr; only the
    // former is parsed, and a non-zero exit is reported rather than guessed at.
    let output = match run_bounded(command, timeout) {
        Ok(output) => output,
        Err(error) => return problem(format!("could not ask Claude Code: {error}")),
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let Some(start) = text.find('{') else {
        return problem(if output.status.success() {
            "the adapter answered, but not with the JSON status it prints".into()
        } else {
            format!("the adapter exited {}", output.status.code().unwrap_or(-1))
        });
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text[start..]) else {
        return problem("the adapter's status output could not be read as JSON".into());
    };
    ProviderAuthStatus {
        provider: Provider::Claude,
        logged_in: field(&value, &["loggedIn", "logged_in"]).and_then(serde_json::Value::as_bool),
        method: field(&value, &["authMethod", "auth_method"]).and_then(serde_json::Value::as_str).map(str::to_string),
        account: field(&value, &["account", "email"]).and_then(serde_json::Value::as_str).map(str::to_string),
        plan: field(&value, &["subscriptionType", "plan"]).and_then(serde_json::Value::as_str).map(str::to_string),
        problem: None,
    }
}

/// Reads the account's model catalog over ACP.
///
/// The catalog is per account and only populated once the adapter is signed
/// in — an unauthenticated adapter answers with nothing, which is reported as
/// such rather than as an empty list of choices. A session is opened in a
/// scratch directory to ask, because that is where the catalog is advertised;
/// nothing about the user's project is touched.
pub fn read_models(executable: &PathBuf, args: &[String], scratch: &std::path::Path, timeout: Duration) -> Result<Vec<ProviderModel>, String> {
    use std::io::{BufRead, BufReader, Write};

    std::fs::create_dir_all(scratch).map_err(|error| error.to_string())?;
    let mut child = Command::new(executable)
        .args(args)
        .current_dir(scratch)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("could not start the adapter: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("the adapter took no input")?;
    let stdout = child.stdout.take().ok_or("the adapter produced no output")?;

    let request = |id: u32, method: &str, params: String| format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"{method}\",\"params\":{params}}}\n");
    let handshake = request(1, "initialize", r#"{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false}}}"#.into());
    let open = request(2, "session/new", format!(r#"{{"cwd":{:?},"mcpServers":[]}}"#, scratch.to_string_lossy()));

    let reader = std::thread::spawn(move || {
        let mut found = None;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            if value.get("id").and_then(serde_json::Value::as_u64) == Some(2) {
                found = value.get("result").cloned();
                break;
            }
        }
        found
    });

    let write = stdin.write_all(handshake.as_bytes()).and_then(|()| stdin.flush());
    if let Err(error) = write {
        let _ = child.kill();
        return Err(format!("the adapter closed its input: {error}"));
    }
    // The adapter answers `initialize` before it will accept a session; a short
    // pause is enough and avoids parsing two responses out of one stream.
    std::thread::sleep(Duration::from_millis(700));
    let _ = stdin.write_all(open.as_bytes()).and_then(|()| stdin.flush());

    let started = std::time::Instant::now();
    while !reader.is_finished() && started.elapsed() < timeout {
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
    let result = reader.join().map_err(|_| "the adapter reader failed".to_string())?;
    let Some(result) = result else {
        return Err(format!("the adapter did not answer within {}s", timeout.as_secs()));
    };

    let options = result
        .get("configOptions")
        .and_then(serde_json::Value::as_array)
        .ok_or("the adapter advertised no configuration options")?;
    let model_option = options
        .iter()
        .find(|option| option.get("id").and_then(serde_json::Value::as_str) == Some("model"))
        .ok_or("the adapter advertises no model selection")?;
    let listed = model_option.get("options").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
    // Claude Code's effort is one session option for every model, so each
    // model is offered the same levels.
    let effort_option = options
        .iter()
        .find(|option| matches!(option.get("id").and_then(serde_json::Value::as_str), Some("effort" | "reasoning_effort")));
    let efforts: Vec<String> = effort_option
        .and_then(|option| option.get("options"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|choice| choice.get("value").and_then(serde_json::Value::as_str))
        .filter(|value| *value != "default")
        .map(str::to_string)
        .collect();
    let default_effort = effort_option.and_then(|option| option.get("currentValue")).and_then(serde_json::Value::as_str).filter(|value| *value != "default").map(str::to_string);
    let current_model = model_option.get("currentValue").and_then(serde_json::Value::as_str);
    if listed.is_empty() {
        return Err("the adapter listed no models; it is probably not signed in".into());
    }
    Ok(listed
        .iter()
        .filter_map(|option| {
            let id = option.get("value").and_then(serde_json::Value::as_str)?;
            // `default` is an alias for whichever model the account defaults
            // to, which is listed on its own.
            if id == "default" {
                return None;
            }
            let description = option.get("description").and_then(serde_json::Value::as_str).map(str::to_string);
            Some(ProviderModel {
                id: id.to_string(),
                name: option.get("name").and_then(serde_json::Value::as_str).unwrap_or(id).to_string(),
                needs_credits: description.as_deref().is_some_and(|text| text.to_lowercase().contains("credit")),
                description,
                efforts: efforts.clone(),
                default_effort: default_effort.clone(),
                input_image: true,
                is_default: current_model == Some(id),
            })
        })
        .collect())
}
