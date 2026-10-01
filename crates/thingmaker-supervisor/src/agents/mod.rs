//! The agents the desktop can attach to, and everything about them that is
//! not ordinary ACP.
//!
//! The session actor is provider-agnostic — ACP over stdio, one turn at a
//! time — and the places where providers genuinely differ are gathered here:
//! the command line, how the session id is chosen, what `session/new` carries,
//! how subagents and quota appear, and where the transcript lives. A reader
//! who wants to know what "Claude-specific" or "Codex-specific" means should
//! find the whole answer in this module.
//!
//! Adding a provider is one variant of [`Provider`], one of [`AgentLaunch`]
//! and one submodule. An agent CLI that already speaks ACP needs nothing
//! else; one that speaks its own protocol gets a bridge that translates it
//! into ACP inside the supervisor, the way `codex` does.

pub mod auth;
pub mod claude;
pub mod codex;
pub mod events;
pub mod gemini;
pub mod login;
pub mod usage;

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use self::{claude::launch::ClaudeLaunchOptions, codex::launch::CodexLaunchOptions, gemini::launch::GeminiLaunchOptions};

/// What an attachment may do without asking, decided once from the
/// workspace's trust state (§2.2).
///
/// An agent runs unattended for hours, so a permission request nobody answers
/// would end it at its first edit. Each provider maps the stance onto its own
/// modes: Claude Code's `acceptEdits`/`plan`, Codex's sandbox and approval
/// policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionStance {
    /// Edits are accepted without asking; anything else that still arrives is
    /// allowed and journalled. For a `trusted_local` workspace, which is the
    /// same gate a desktop-run check passes.
    AcceptEdits,
    /// The agent plans rather than acts, and what still arrives is refused.
    /// For `inspect_only`.
    ReadOnly,
}

impl PermissionStance {
    /// Whether a permission request that still arrives is allowed. Edits are
    /// pre-answered by the mode; this is for the rest — shell, network, a
    /// tool the mode does not cover.
    pub fn allows(self) -> bool {
        matches!(self, Self::AcceptEdits)
    }
}

/// The subscription an attachment runs on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    #[default]
    Claude,
    Codex,
    /// Antigravity's `agy`: a worker or a plain session, never an
    /// orchestrator (it cannot take a session's own MCP server).
    Gemini,
}

impl Provider {
    pub const ALL: [Provider; 3] = [Provider::Claude, Provider::Codex, Provider::Gemini];

    /// Whether a session on this provider can lead a team: it has to take
    /// the session's own `team` MCP server.
    pub fn can_orchestrate(self) -> bool {
        !matches!(self, Self::Gemini)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
        }
    }

    /// Reads a stored value. Unknown values are an error rather than a
    /// default: a session recorded under a provider this build does not have
    /// cannot be opened, and pretending otherwise would launch the wrong one.
    pub fn parse(value: &str) -> Option<Provider> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "gemini" => Some(Self::Gemini),
            _ => None,
        }
    }

    /// What to call it on screen and in an error a person reads.
    pub fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
            Self::Gemini => "Gemini",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentLaunch {
    Claude(ClaudeLaunchOptions),
    Codex(CodexLaunchOptions),
    Gemini(GeminiLaunchOptions),
}

impl AgentLaunch {
    pub fn provider(&self) -> Provider {
        match self {
            Self::Claude(_) => Provider::Claude,
            Self::Codex(_) => Provider::Codex,
            Self::Gemini(_) => Provider::Gemini,
        }
    }

    pub fn root(&self) -> &Path {
        match self {
            Self::Claude(options) => &options.root,
            Self::Codex(options) => &options.root,
            Self::Gemini(options) => &options.root,
        }
    }

    pub fn arguments(&self) -> Vec<String> {
        match self {
            Self::Claude(options) => options.arguments(),
            Self::Codex(options) => options.arguments(),
            Self::Gemini(options) => options.arguments(),
        }
    }

    /// The id this attachment is addressed by inside the desktop.
    ///
    /// Agents choose their own session ids and say so in the `session/new`
    /// reply, so on a new session this is a reservation the agent will
    /// replace, and on a resume it is the agent's own id handed back to it.
    /// Pure either way: the reservation is made once, when the options are
    /// built, because the handle and the duplicate-attachment check both read
    /// this and a fresh id per call would let them disagree.
    pub fn session_id(&self) -> String {
        match self {
            Self::Claude(options) => options.resume.clone().unwrap_or_else(|| options.reserved.to_string()),
            Self::Codex(options) => options.resume.clone().unwrap_or_else(|| options.reserved.to_string()),
            Self::Gemini(options) => options.resume.clone().unwrap_or_else(|| options.reserved.to_string()),
        }
    }

    /// Whether this attachment resumes a session the agent already has.
    pub fn is_resume(&self) -> bool {
        match self {
            Self::Claude(options) => options.resume.is_some(),
            Self::Codex(options) => options.resume.is_some(),
            Self::Gemini(options) => options.resume.is_some(),
        }
    }

    /// The permission stance this attachment runs under.
    pub fn permission(&self) -> PermissionStance {
        match self {
            Self::Claude(options) => options.permission_mode,
            Self::Codex(options) => options.permission_mode,
            Self::Gemini(options) => options.permission_mode,
        }
    }

    /// The `mode` config option value for [`AgentLaunch::permission`], by
    /// the agent's own id for it.
    pub fn permission_mode_id(&self) -> &'static str {
        match self {
            Self::Claude(options) => claude::launch::mode_id(options.permission_mode),
            Self::Codex(options) => codex::launch::sandbox_mode(options.permission_mode),
            Self::Gemini(options) => gemini::launch::mode_id(options.permission_mode),
        }
    }

    /// The model to select once the session is open.
    pub fn deferred_model(&self) -> Option<&str> {
        match self {
            Self::Claude(options) => options.model.as_deref(),
            Self::Codex(options) => options.model.as_deref(),
            Self::Gemini(options) => options.model.as_deref(),
        }
    }

    /// Where to land when `deferred_model` cannot be selected.
    pub fn deferred_model_fallback(&self) -> Option<&str> {
        match self {
            Self::Claude(options) => options.model_fallback.as_deref(),
            Self::Codex(_) | Self::Gemini(_) => None,
        }
    }

    /// The reasoning effort to select once the session is open.
    pub fn deferred_effort(&self) -> Option<&str> {
        match self {
            Self::Claude(options) => options.effort.as_deref(),
            Self::Codex(options) => options.effort.as_deref(),
            Self::Gemini(options) => options.effort.as_deref(),
        }
    }

    /// `_meta` for `session/new` and `session/load`, when the provider takes
    /// options there that it has no config option for.
    pub fn session_meta(&self) -> Option<Value> {
        match self {
            Self::Claude(options) => options.session_meta(),
            Self::Codex(_) | Self::Gemini(_) => None,
        }
    }

    /// Variables this provider's program needs set beyond the documented
    /// profile: Codex's `CODEX_HOME` for an account that is not the default.
    pub fn environment(&self) -> Vec<(String, String)> {
        match self {
            Self::Claude(_) | Self::Gemini(_) => Vec::new(),
            Self::Codex(options) => options
                .codex_home
                .iter()
                .map(|home| ("CODEX_HOME".to_string(), home.to_string_lossy().into_owned()))
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::launch::SessionId;

    #[test]
    fn providers_round_trip_through_their_stored_names() {
        for provider in Provider::ALL {
            assert_eq!(Provider::parse(provider.as_str()), Some(provider));
        }
        assert_eq!(Provider::parse("kit"), None, "a Kit session cannot be opened by this build");
    }

    #[test]
    fn the_agent_chooses_the_session_id_unless_it_is_handed_back() {
        let fresh = AgentLaunch::Claude(ClaudeLaunchOptions::new("/work", "/usr/bin/node", vec!["adapter.js".into()]));
        assert!(!fresh.is_resume());
        // The reservation is only a placeholder, but it still has to be a
        // legal session id: it is the handle the desktop addresses. And it
        // has to be the *same* one every time it is asked, or the handle and
        // the duplicate-attachment check would name different sessions.
        assert!(SessionId::new(fresh.session_id()).is_ok());
        assert_eq!(fresh.session_id(), fresh.session_id());

        let mut options = ClaudeLaunchOptions::new("/work", "/usr/bin/node", vec!["adapter.js".into()]);
        options.resume = Some("d847b2a3-c7b5-4459-8b0f-02fdd03031a4".into());
        options.model = Some("sonnet".into());
        options.permission_mode = PermissionStance::AcceptEdits;
        let resumed = AgentLaunch::Claude(options);
        assert_eq!(resumed.session_id(), "d847b2a3-c7b5-4459-8b0f-02fdd03031a4");
        assert!(resumed.is_resume(), "a resume hands the id back");
        assert_eq!(resumed.deferred_model(), Some("sonnet"));
        assert_eq!(resumed.permission(), PermissionStance::AcceptEdits);
        assert_eq!(resumed.permission_mode_id(), "acceptEdits");
        assert_eq!(resumed.arguments(), ["adapter.js"]);
        assert_eq!(resumed.provider(), Provider::Claude);
        assert_eq!(resumed.root(), Path::new("/work"));
    }
}
