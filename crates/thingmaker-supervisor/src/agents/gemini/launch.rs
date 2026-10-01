//! Launch contract for Antigravity's official CLI, `agy`.
//!
//! `agy -p= --input-format stream-json --output-format stream-json` is one
//! process for a whole conversation: a user event per line on stdin, events
//! per line on stdout (docs/research/multi-provider-viability.md §7, S3).
//! Unlike the other providers, everything about a session is a flag: the
//! model, the effort, the permission mode and the conversation to resume. A
//! change to any of them is a relaunch with `--conversation`, which the
//! bridge does between turns.
//!
//! Permission stances, from the live probe:
//!
//! - `ReadOnly` is `--mode plan`: workspace writes are refused (soft: the turn
//!   still succeeds and says what it was denied).
//! - `AcceptEdits` is `--mode accept-edits --dangerously-skip-permissions`.
//!   `accept-edits` alone refuses every shell command in headless mode, and
//!   the only other way to allow them is rules in the user's own settings,
//!   which the desktop does not edit. Skipping the prompts is what the
//!   desktop already answers for Claude and Codex in a trusted workspace:
//!   every request is allowed and journalled. Chosen by the user on
//!   1 October 2026.

use std::path::{Path, PathBuf};

use crate::{acp::launch::SessionId, agents::PermissionStance};

/// Environment override for the `agy` binary.
pub const PROGRAM_ENV: &str = "THINGMAKER_AGY";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeminiLaunchOptions {
    /// Canonical workspace root; the process's working directory.
    pub root: PathBuf,
    /// The `agy` binary.
    pub program: PathBuf,
    /// The id the desktop addresses this attachment by until `agy` names its
    /// conversation in `init`.
    pub reserved: SessionId,
    /// A model slug from `agy models` (`gemini-3.1-pro-high`, …).
    pub model: Option<String>,
    /// `low` … `max`.
    pub effort: Option<String>,
    /// The conversation to resume.
    pub resume: Option<String>,
    pub permission_mode: PermissionStance,
}

impl GeminiLaunchOptions {
    pub fn new(root: impl Into<PathBuf>, program: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            program: program.into(),
            reserved: SessionId::reserve(),
            model: None,
            effort: None,
            resume: None,
            permission_mode: PermissionStance::ReadOnly,
        }
    }

    /// The command line for the first launch.
    pub fn arguments(&self) -> Vec<String> {
        arguments(self.model.as_deref(), self.effort.as_deref(), self.permission_mode, self.resume.as_deref())
    }
}

/// The command line for a launch with these settings. `-p` takes its value
/// attached: `-p` followed by a separate argument would read that argument as
/// the prompt.
pub fn arguments(model: Option<&str>, effort: Option<&str>, stance: PermissionStance, conversation: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = ["-p=", "--input-format", "stream-json", "--output-format", "stream-json"].map(str::to_string).to_vec();
    if let Some(model) = model.filter(|model| !model.is_empty()) {
        args.extend(["--model".into(), model.into()]);
    }
    if let Some(effort) = effort.filter(|effort| !effort.is_empty() && *effort != "default") {
        args.extend(["--effort".into(), effort.into()]);
    }
    args.extend(["--mode".into(), mode_id(stance).into()]);
    if stance == PermissionStance::AcceptEdits {
        args.push("--dangerously-skip-permissions".into());
    }
    if let Some(conversation) = conversation.filter(|id| !id.is_empty()) {
        args.extend(["--conversation".into(), conversation.into()]);
    }
    args
}

/// `agy`'s own name for a stance.
pub fn mode_id(stance: PermissionStance) -> &'static str {
    match stance {
        PermissionStance::AcceptEdits => "accept-edits",
        PermissionStance::ReadOnly => "plan",
    }
}

/// Where `agy` keeps a conversation: one database per id. A session with no
/// file has nothing to resume.
pub fn conversation_path(home: &Path, conversation: &str) -> PathBuf {
    home.join(".gemini/antigravity-cli/conversations").join(format!("{conversation}.db"))
}

/// `agy` where its installer puts it, on PATH, or in the usual prefixes. A
/// desktop app launched from the Dock has no shell PATH, so the installer's
/// directory is checked first.
pub fn find_program(home: &Path) -> Option<PathBuf> {
    let mut candidates = vec![home.join(".local/bin/agy")];
    let path = std::env::var_os("PATH").unwrap_or_default();
    candidates.extend(std::env::split_paths(&path).map(|dir| dir.join("agy")));
    candidates.extend([PathBuf::from("/opt/homebrew/bin/agy"), PathBuf::from("/usr/local/bin/agy")]);
    candidates.into_iter().find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trusted_workspace_edits_and_runs_commands_and_an_inspected_one_plans() {
        let trusted = arguments(Some("gemini-3.1-pro-high"), Some("high"), PermissionStance::AcceptEdits, None);
        assert_eq!(&trusted[..5], ["-p=", "--input-format", "stream-json", "--output-format", "stream-json"]);
        assert!(trusted.windows(2).any(|pair| pair == ["--model", "gemini-3.1-pro-high"]));
        assert!(trusted.windows(2).any(|pair| pair == ["--effort", "high"]));
        assert!(trusted.windows(2).any(|pair| pair == ["--mode", "accept-edits"]));
        assert!(trusted.contains(&"--dangerously-skip-permissions".to_string()));

        let inspected = arguments(None, Some("default"), PermissionStance::ReadOnly, Some("16b66afc"));
        assert!(inspected.windows(2).any(|pair| pair == ["--mode", "plan"]));
        assert!(!inspected.contains(&"--dangerously-skip-permissions".to_string()), "read-only never skips a prompt");
        assert!(!inspected.contains(&"--effort".to_string()), "the default effort is no flag");
        assert!(inspected.ends_with(&["--conversation".to_string(), "16b66afc".to_string()]));
        assert_eq!(GeminiLaunchOptions::new("/w", "/agy").permission_mode, PermissionStance::ReadOnly);
        assert_eq!(conversation_path(Path::new("/Users/me"), "c1"), PathBuf::from("/Users/me/.gemini/antigravity-cli/conversations/c1.db"));
    }
}
