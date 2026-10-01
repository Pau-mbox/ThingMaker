//! Running an Odyssey milestone's check (docs/plans/odyssey.md §5).
//!
//! This is the desktop-run lane: Odyssey chose the command, Odyssey read the
//! exit code, and the agent was not in the loop. That is the whole point, so
//! this module deliberately does nothing clever — it runs what the milestone
//! says, bounds it in time and size, and reports the exit code.
//!
//! A check is executable code from the milestone's `check_spec`, so it runs
//! only for a trusted workspace (the caller gates that), only in the workspace
//! root, with no inherited terminal, and never for a `manual` milestone.

use std::{
    io::Read,
    path::Path,
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use crate::{error::DesktopError, storage::odyssey::CheckKind, workspace::explorer::resolve_contained};

/// Longest a check may run. A suite can be slow; a hung one must not park the
/// runner for ever, and the timeout is reported as a failure with its reason.
const CHECK_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Output kept for the record: the tail, because a failure explains itself at
/// the end. Matches the 8 KiB the plan specifies.
const KEPT_OUTPUT_BYTES: usize = 8 * 1024;

/// Paths a `files_exist` check may list, so a pasted document cannot ask for a
/// filesystem walk.
const MAX_PATHS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckOutcome {
    pub passed: bool,
    /// The exit code, when the check was a process that finished.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// One line for the badge: what ran and how it ended.
    pub summary: String,
    /// The evidence stored on the milestone (bounded tail).
    pub output: String,
    pub duration_ms: u64,
    pub timed_out: bool,
}

/// Whether this kind of check is something the desktop can run at all.
pub fn is_runnable(kind: CheckKind) -> bool {
    matches!(kind, CheckKind::Command | CheckKind::TestsPass | CheckKind::FilesExist)
}

/// Runs a milestone's check in `root` and reports what happened.
pub fn run_check(root: &Path, kind: CheckKind, spec: Option<&str>) -> Result<CheckOutcome, DesktopError> {
    let spec = spec.map(str::trim).filter(|value| !value.is_empty());
    match kind {
        CheckKind::Manual => Err(DesktopError::unsupported("a manual milestone is verified by you, not by a command")),
        CheckKind::FilesExist => {
            let spec = spec.ok_or_else(|| DesktopError::unsupported("this milestone lists no paths to check"))?;
            files_exist(root, spec)
        }
        CheckKind::Command | CheckKind::TestsPass => {
            let spec = spec.ok_or_else(|| DesktopError::unsupported("this milestone names no command to run"))?;
            run_command(root, spec)
        }
    }
}

/// Splits a `files_exist` spec. Newlines and commas separate paths, because a
/// path may contain spaces and splitting on those would break real filenames.
fn split_paths(spec: &str) -> Vec<&str> {
    spec.split(['\n', ',']).map(str::trim).filter(|value| !value.is_empty()).collect()
}

fn files_exist(root: &Path, spec: &str) -> Result<CheckOutcome, DesktopError> {
    let started = Instant::now();
    let paths = split_paths(spec);
    if paths.is_empty() {
        return Err(DesktopError::unsupported("this milestone lists no paths to check"));
    }
    if paths.len() > MAX_PATHS {
        return Err(DesktopError::limit_exceeded(format!("a files_exist check may list at most {MAX_PATHS} paths")));
    }

    let mut lines = Vec::new();
    let mut missing = 0usize;
    for candidate in &paths {
        // Contained on purpose: a check may not stat outside the workspace.
        match resolve_contained(root, candidate) {
            Ok(path) => match std::fs::metadata(&path) {
                Ok(metadata) if metadata.is_dir() => lines.push(format!("{candidate}: directory")),
                Ok(metadata) => lines.push(format!("{candidate}: {} bytes", metadata.len())),
                Err(_) => {
                    missing += 1;
                    lines.push(format!("{candidate}: missing"));
                }
            },
            Err(error) => {
                missing += 1;
                lines.push(format!("{candidate}: {}", error.message));
            }
        }
    }

    let passed = missing == 0;
    let summary = if passed {
        format!("all {} path{} exist", paths.len(), if paths.len() == 1 { "" } else { "s" })
    } else {
        format!("{missing} of {} path{} missing", paths.len(), if paths.len() == 1 { "" } else { "s" })
    };
    Ok(CheckOutcome {
        passed,
        exit_code: None,
        summary,
        output: lines.join("\n"),
        duration_ms: started.elapsed().as_millis() as u64,
        timed_out: false,
    })
}

/// Keeps only the tail of a stream, so a chatty suite cannot fill memory.
struct Tail {
    bytes: Vec<u8>,
}

impl Tail {
    fn new() -> Self {
        Self { bytes: Vec::new() }
    }

    fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() > KEPT_OUTPUT_BYTES * 4 {
            let start = self.bytes.len() - KEPT_OUTPUT_BYTES;
            self.bytes.drain(..start);
        }
    }

    fn finish(mut self) -> String {
        if self.bytes.len() > KEPT_OUTPUT_BYTES {
            let start = self.bytes.len() - KEPT_OUTPUT_BYTES;
            self.bytes.drain(..start);
        }
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
}

fn drain<R: Read + Send + 'static>(mut source: R) -> mpsc::Receiver<String> {
    let (sender, receiver) = mpsc::channel();
    // A reader thread per stream: polling the child while its pipe fills would
    // deadlock as soon as a suite printed more than the buffer.
    std::thread::spawn(move || {
        let mut tail = Tail::new();
        let mut buffer = [0u8; 8192];
        loop {
            match source.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => tail.push(&buffer[..read]),
            }
        }
        let _ = sender.send(tail.finish());
    });
    receiver
}

fn shell() -> (&'static str, &'static str) {
    if cfg!(windows) { ("cmd", "/C") } else { ("/bin/sh", "-c") }
}

fn run_command(root: &Path, spec: &str) -> Result<CheckOutcome, DesktopError> {
    let started = Instant::now();
    let (program, flag) = shell();
    let mut child = Command::new(program)
        .arg(flag)
        .arg(spec)
        .current_dir(root)
        // No terminal and no pager: a check that waits for input is a hang.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("CI", "1")
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .env("GIT_TERMINAL_PROMPT", "0")
        .spawn()
        .map_err(|error| DesktopError::io(format!("could not start the check: {error}")))?;

    let stdout = child.stdout.take().map(drain);
    let stderr = child.stderr.take().map(drain);

    let mut timed_out = false;
    let status = loop {
        match child.try_wait().map_err(|error| DesktopError::io(error.to_string()))? {
            Some(status) => break Some(status),
            None => {
                if started.elapsed() >= CHECK_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break None;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    };

    let read = |receiver: Option<mpsc::Receiver<String>>| receiver.and_then(|r| r.recv_timeout(Duration::from_secs(5)).ok()).unwrap_or_default();
    let out = read(stdout);
    let err = read(stderr);
    let combined = match (out.trim().is_empty(), err.trim().is_empty()) {
        (true, true) => String::new(),
        (false, true) => out,
        (true, false) => err,
        (false, false) => format!("{out}\n{err}"),
    };

    let exit_code = status.and_then(|status| status.code());
    let passed = !timed_out && status.map(|status| status.success()).unwrap_or(false);
    let summary = if timed_out {
        format!("`{spec}` was still running after {} minutes and was stopped", CHECK_TIMEOUT.as_secs() / 60)
    } else {
        match exit_code {
            Some(0) => format!("`{spec}` exited 0"),
            Some(code) => format!("`{spec}` exited {code}"),
            // Killed by a signal: no code to report, and not a pass.
            None => format!("`{spec}` ended without an exit code"),
        }
    };

    Ok(CheckOutcome {
        passed,
        exit_code,
        summary,
        output: combined,
        duration_ms: started.elapsed().as_millis() as u64,
        timed_out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn a_command_that_exits_zero_passes_and_keeps_its_output() {
        let dir = workspace();
        let outcome = run_check(dir.path(), CheckKind::Command, Some("echo hello")).expect("ran");
        assert!(outcome.passed);
        assert_eq!(outcome.exit_code, Some(0));
        assert!(outcome.output.contains("hello"));
        assert!(outcome.summary.contains("exited 0"));
    }

    #[test]
    fn a_failing_command_fails_and_says_the_code() {
        let dir = workspace();
        let outcome = run_check(dir.path(), CheckKind::TestsPass, Some("echo boom >&2; exit 3")).expect("ran");
        assert!(!outcome.passed);
        assert_eq!(outcome.exit_code, Some(3));
        assert!(outcome.output.contains("boom"), "stderr is evidence too: {}", outcome.output);
        assert!(outcome.summary.contains("exited 3"));
    }

    #[test]
    fn a_check_runs_in_the_workspace_root() {
        let dir = workspace();
        std::fs::write(dir.path().join("marker.txt"), b"x").expect("write");
        let outcome = run_check(dir.path(), CheckKind::Command, Some("test -f marker.txt")).expect("ran");
        assert!(outcome.passed);
    }

    #[test]
    fn only_the_tail_of_a_chatty_check_is_kept() {
        let dir = workspace();
        // 200k lines is far past the kept window.
        let outcome = run_check(dir.path(), CheckKind::Command, Some("seq 1 200000")).expect("ran");
        assert!(outcome.passed);
        assert!(outcome.output.len() <= KEPT_OUTPUT_BYTES, "kept {} bytes", outcome.output.len());
        assert!(outcome.output.trim_end().ends_with("200000"), "the tail is what explains a failure");
    }

    #[test]
    fn files_exist_passes_only_when_every_path_is_there() {
        let dir = workspace();
        std::fs::write(dir.path().join("a.txt"), b"aa").expect("write");
        let ok = run_check(dir.path(), CheckKind::FilesExist, Some("a.txt")).expect("ran");
        assert!(ok.passed);
        assert!(ok.output.contains("2 bytes"));

        let missing = run_check(dir.path(), CheckKind::FilesExist, Some("a.txt, b.txt")).expect("ran");
        assert!(!missing.passed);
        assert!(missing.summary.contains("1 of 2"));
        assert!(missing.output.contains("b.txt: missing"));
    }

    #[test]
    fn files_exist_refuses_to_look_outside_the_workspace() {
        let dir = workspace();
        let outcome = run_check(dir.path(), CheckKind::FilesExist, Some("../escape.txt\n/etc/hosts")).expect("ran");
        assert!(!outcome.passed);
        // Both are refused as paths, not reported as present.
        assert!(!outcome.output.contains("bytes"), "{}", outcome.output);
    }

    #[test]
    fn a_manual_milestone_is_not_something_the_desktop_can_run() {
        let dir = workspace();
        let error = run_check(dir.path(), CheckKind::Manual, Some("anything")).expect_err("refused");
        assert!(error.message.contains("verified by you"));
        assert!(!is_runnable(CheckKind::Manual));
    }

    #[test]
    fn a_check_with_no_spec_is_refused_rather_than_guessed() {
        let dir = workspace();
        assert!(run_check(dir.path(), CheckKind::Command, None).is_err());
        assert!(run_check(dir.path(), CheckKind::Command, Some("   ")).is_err());
        assert!(run_check(dir.path(), CheckKind::FilesExist, Some("")).is_err());
    }
}
