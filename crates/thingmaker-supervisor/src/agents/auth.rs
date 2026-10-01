//! What a provider says about its sign-in and the models its account can
//! select, in one shape for every provider.
//!
//! Each provider answers through its own official program — Claude Code's
//! adapter CLI, `codex app-server` — and the desktop only ever reads what that
//! program reports. No token is read, stored or passed on here.

use std::{process::Command, time::Duration};

use serde::{Deserialize, Serialize};

use super::Provider;

/// What a provider reported about its own authentication.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthStatus {
    pub provider: Provider,
    /// `None` when the provider could not be asked, with `problem` saying why.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logged_in: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// The subscription plan, when the provider names it (`plus`, `team`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

impl ProviderAuthStatus {
    pub fn problem(provider: Provider, text: impl Into<String>) -> Self {
        Self {
            provider,
            logged_in: None,
            method: None,
            account: None,
            plan: None,
            problem: Some(text.into()),
        }
    }
}

/// One model a provider says this account can select.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    /// The selection id to pass back to the provider, verbatim.
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// True when the provider's own description says it costs beyond the
    /// subscription. Surfaced so nothing reaches for paid credit unasked.
    pub needs_credits: bool,
    /// Reasoning efforts the model takes, by the provider's ids. Empty when
    /// effort is a session option rather than a per-model list.
    #[serde(default)]
    pub efforts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    /// Whether the model reads images.
    pub input_image: bool,
    /// The provider's own default.
    pub is_default: bool,
}

/// Runs a command with a deadline, killing it if it overruns. A provider CLI
/// that hangs on a handshake must not hang the panel that asked it a
/// question.
pub fn run_bounded(mut command: Command, timeout: Duration) -> Result<std::process::Output, String> {
    let mut child = command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(_) => break,
            None if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("it did not answer within {}s", timeout.as_secs()));
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    child.wait_with_output().map_err(|error| error.to_string())
}
