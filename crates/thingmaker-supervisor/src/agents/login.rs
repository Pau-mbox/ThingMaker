//! Running a provider's own sign-in program, streaming what it says.
//!
//! Shared by every provider: Claude Code signs in with
//! `claude-agent-acp --cli auth login --claudeai`, Codex with `codex login`.
//! The streaming, the URL the user clicks, cancellation and the timeout are
//! the same either way. No token ever passes through here — the child writes
//! to its own store — and a URL is only surfaced, never opened: sign-in
//! completes in the provider's own flow, in the user's own browser.

use std::{process::Stdio, time::Duration};

use serde::Serialize;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot},
    time,
};

use crate::{acp::updates::cap_chars, error::DesktopError, security::EnvironmentProfile};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum LoginEvent {
    Started { pid: Option<u32> },
    Line { stream: &'static str, text: String },
    /// A URL the provider asked the user to open. Shown for explicit opening;
    /// never opened automatically.
    Url { url: String },
    Exited { status: Option<i32>, success: bool, cancelled: bool, timed_out: bool },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginOutcome {
    pub status: Option<i32>,
    pub success: bool,
    pub cancelled: bool,
    pub timed_out: bool,
}

/// Finds the first http(s) URL in a line of output.
pub fn extract_url(line: &str) -> Option<String> {
    let start = line.find("https://").or_else(|| line.find("http://"))?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '>' || c == ')')
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches(['.', ',']);
    if url.len() > 8 { Some(url.to_string()) } else { None }
}

/// Runs one sign-in program to completion, streaming its output.
pub async fn run_login_process(
    executable: &std::path::Path,
    args: &[String],
    environment: &EnvironmentProfile,
    timeout: Duration,
    events: mpsc::Sender<LoginEvent>,
    mut cancel: oneshot::Receiver<()>,
) -> Result<LoginOutcome, DesktopError> {
    let env = environment.resolve(std::env::vars());
    let mut command = Command::new(executable);
    command
        .args(args)
        .env_clear()
        .envs(&env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| DesktopError::io(format!("could not start sign-in: {error}")))?;
    let _ = events.send(LoginEvent::Started { pid: child.id() }).await;

    let stdout = child.stdout.take().map(|s| BufReader::new(s).lines());
    let stderr = child.stderr.take().map(|s| BufReader::new(s).lines());
    let (line_tx, mut line_rx) = mpsc::channel::<(&'static str, String)>(256);
    if let Some(mut lines) = stdout {
        let tx = line_tx.clone();
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                if tx.send(("stdout", line)).await.is_err() {
                    break;
                }
            }
        });
    }
    if let Some(mut lines) = stderr {
        let tx = line_tx.clone();
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                if tx.send(("stderr", line)).await.is_err() {
                    break;
                }
            }
        });
    }
    drop(line_tx);

    let deadline = time::Instant::now() + timeout;
    let mut cancelled = false;
    let mut timed_out = false;
    let mut lines_open = true;
    let mut exit_status: Option<std::process::ExitStatus> = None;
    loop {
        tokio::select! {
            line = line_rx.recv(), if lines_open => {
                match line {
                    Some((stream, text)) => {
                        let text = cap_chars(&text, 4096);
                        if let Some(url) = extract_url(&text) {
                            let _ = events.send(LoginEvent::Url { url }).await;
                        }
                        let _ = events.send(LoginEvent::Line { stream, text }).await;
                    }
                    None => lines_open = false,
                }
            }
            status = child.wait(), if exit_status.is_none() => {
                exit_status = Some(status.map_err(|e| DesktopError::io(e.to_string()))?);
                if !lines_open {
                    break;
                }
            }
            _ = &mut cancel, if !cancelled && exit_status.is_none() => {
                cancelled = true;
                let _ = child.start_kill();
            }
            _ = time::sleep_until(deadline), if !timed_out && exit_status.is_none() => {
                timed_out = true;
                let _ = child.start_kill();
            }
        }
        if exit_status.is_some() && !lines_open {
            break;
        }
    }
    let status = exit_status.and_then(|s| s.code());
    let success = exit_status.is_some_and(|s| s.success()) && !cancelled && !timed_out;
    let _ = events
        .send(LoginEvent::Exited { status, success, cancelled, timed_out })
        .await;
    Ok(LoginOutcome { status, success, cancelled, timed_out })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn python() -> Option<std::path::PathBuf> {
        let ok = std::process::Command::new("python3").arg("--version").output().ok()?.status.success();
        ok.then(|| std::path::PathBuf::from("python3"))
    }

    #[test]
    fn url_extraction() {
        assert_eq!(
            extract_url("Open this URL to authenticate:\nhttps://claude.ai/oauth/authorize?x=1&y=2 now."),
            Some("https://claude.ai/oauth/authorize?x=1&y=2".into())
        );
        assert_eq!(extract_url("no url here"), None);
    }

    #[tokio::test]
    async fn a_login_run_streams_its_url_and_exit() {
        let Some(python) = python() else { return };
        let script = "import sys,time\nprint('Open this URL:\\nhttps://example.test/authorize?code=1')\nsys.stdout.flush()\nsys.stderr.write('waiting\\n')\ntime.sleep(0.1)\nprint('Signed in.')\n";
        let (tx, mut rx) = mpsc::channel(64);
        let (_cancel_tx, cancel_rx) = oneshot::channel();
        let outcome = run_login_process(&python, &["-c".into(), script.into()], &EnvironmentProfile::trusted_local(), Duration::from_secs(10), tx, cancel_rx)
            .await
            .unwrap();
        assert!(outcome.success && !outcome.cancelled && !outcome.timed_out);
        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        assert!(matches!(events[0], LoginEvent::Started { .. }));
        assert!(events.iter().any(|e| matches!(e, LoginEvent::Url { url } if url == "https://example.test/authorize?code=1")));
        assert!(events.iter().any(|e| matches!(e, LoginEvent::Line { stream: "stderr", text } if text == "waiting")));
        assert!(matches!(events.last(), Some(LoginEvent::Exited { success: true, status: Some(0), .. })));
    }

    #[tokio::test]
    async fn a_login_run_can_be_cancelled_and_times_out() {
        let Some(python) = python() else { return };
        let args = vec!["-c".to_string(), "import time\nprint('hang', flush=True)\ntime.sleep(30)\n".to_string()];
        let (tx, _rx) = mpsc::channel(64);
        let (cancel_tx, cancel_rx) = oneshot::channel();
        tokio::spawn(async move {
            time::sleep(Duration::from_millis(200)).await;
            let _ = cancel_tx.send(());
        });
        let outcome = run_login_process(&python, &args, &EnvironmentProfile::trusted_local(), Duration::from_secs(10), tx, cancel_rx)
            .await
            .unwrap();
        assert!(outcome.cancelled && !outcome.success);
        let (tx, _rx) = mpsc::channel(64);
        let (_cancel_tx, cancel_rx) = oneshot::channel();
        let outcome = run_login_process(&python, &args, &EnvironmentProfile::trusted_local(), Duration::from_millis(300), tx, cancel_rx)
            .await
            .unwrap();
        assert!(outcome.timed_out && !outcome.success);
    }
}
