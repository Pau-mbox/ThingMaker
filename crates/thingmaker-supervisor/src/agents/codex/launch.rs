//! Launch contract for `codex app-server`.
//!
//! The program is the official `codex` binary — on PATH, in a global npm
//! prefix, or the one the ChatGPT app ships — run as `codex app-server` on
//! stdio. Everything about a session is said over the protocol: the working
//! directory, sandbox and approval policy on `thread/start`, the model and
//! effort on each `turn/start`.
//!
//! `codex_home` selects the account: Codex keeps its sign-in under
//! `$CODEX_HOME` (default `~/.codex`), so a second directory is a second
//! account, switched without touching the first one's credentials.

use std::path::PathBuf;

use serde_json::{Value, json};

use crate::{acp::launch::SessionId, agents::PermissionStance};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexLaunchOptions {
    /// Canonical workspace root; also the child's working directory and the
    /// thread's `cwd`.
    pub root: PathBuf,
    /// The `codex` binary.
    pub program: PathBuf,
    /// The id the desktop addresses this attachment by until Codex answers
    /// with its thread id (see `AgentLaunch::session_id`).
    pub reserved: SessionId,
    /// The model to run, by Codex's own id (`gpt-6-astra`, …). `None` leaves
    /// the account default.
    pub model: Option<String>,
    /// The reasoning effort, by Codex's own id (`low` … `max`).
    pub effort: Option<String>,
    /// The thread to resume, from a previous run.
    pub resume: Option<String>,
    pub permission_mode: PermissionStance,
    /// `$CODEX_HOME` for this session, when it is not the default account.
    pub codex_home: Option<PathBuf>,
    /// Developer instructions for the thread: an orchestrator's briefing on
    /// its team.
    pub developer_instructions: Option<String>,
    /// Config overrides for the thread (`features.multi_agent`, …), beside
    /// the session's MCP servers. The user's `config.toml` is not touched.
    pub config: serde_json::Map<String, Value>,
}

impl CodexLaunchOptions {
    pub fn new(root: impl Into<PathBuf>, program: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            program: program.into(),
            reserved: SessionId::reserve(),
            model: None,
            effort: None,
            resume: None,
            permission_mode: PermissionStance::ReadOnly,
            codex_home: None,
            developer_instructions: None,
            config: serde_json::Map::new(),
        }
    }

    pub fn arguments(&self) -> Vec<String> {
        vec!["app-server".into()]
    }
}

/// Codex's sandbox for a stance. A trusted workspace may be written; an
/// inspected one may only be read. The user's own `config.toml` may say
/// `danger-full-access`, and a session the desktop starts does not inherit
/// that: the workspace's trust decides, as it does for every provider.
pub fn sandbox_mode(stance: PermissionStance) -> &'static str {
    match stance {
        PermissionStance::AcceptEdits => "workspace-write",
        PermissionStance::ReadOnly => "read-only",
    }
}

/// The override that turns Codex's own multi-agent tools off, for an
/// orchestrator whose workers the combo chooses.
pub const MULTI_AGENT_FEATURE: &str = "features.multi_agent";

/// Codex's approval policy for a stance: `on-request`, so anything beyond the
/// sandbox is asked for — and answered by the stance, on the event stream,
/// rather than silently granted by a `never` policy.
pub fn approval_policy(_stance: PermissionStance) -> &'static str {
    "on-request"
}

/// The `initialize` params Codex's app-server takes.
pub fn initialize_params(name: &str, title: &str, version: &str) -> Value {
    json!({
        "clientInfo": { "name": name, "title": title, "version": version },
        "capabilities": { "experimentalApi": true, "requestAttestation": false }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_workspaces_trust_decides_the_sandbox_not_the_users_config() {
        assert_eq!(sandbox_mode(PermissionStance::AcceptEdits), "workspace-write");
        assert_eq!(sandbox_mode(PermissionStance::ReadOnly), "read-only");
        assert_eq!(approval_policy(PermissionStance::AcceptEdits), "on-request");
        let options = CodexLaunchOptions::new("/work", "/usr/local/bin/codex");
        assert_eq!(options.arguments(), ["app-server"]);
        assert_eq!(options.permission_mode, PermissionStance::ReadOnly, "the safe stance is the default");
    }
}
