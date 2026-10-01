//! Launch contract for `claude-agent-acp`
//! (docs/plans/odyssey-second-orchestrator.md §2.1).
//!
//! The adapter is a Node script, so the executable is the Node binary and the
//! script is its first argument. `locate_adapter` finds the pair: an explicit
//! choice from Settings wins, then `THINGMAKER_CLAUDE_ACP`, then the global npm
//! installs a Mac usually has (nvm, Homebrew, /usr/local). The Node that runs
//! it is the one installed beside it, because a desktop app launched from the
//! Dock has no shell PATH to find `node` on.
//!
//! Almost nothing is a flag. Everything about a session — model, permission
//! mode, effort — is an ACP `configOption` set after `session/new` answers,
//! and the id is the adapter's to choose. Agent SDK options it has no config
//! option for (the tools an orchestrator may not use) travel in
//! `session/new`'s `_meta.claudeCode.options`, which the adapter merges into
//! the SDK query verbatim.

use std::path::{Path, PathBuf};



use crate::{acp::launch::SessionId, agents::PermissionStance, error::DesktopError};

/// The npm package the adapter ships as, and its entry point inside it.
pub const ADAPTER_PACKAGE: &str = "@agentclientprotocol/claude-agent-acp";
const ADAPTER_ENTRY: &str = "dist/index.js";

/// Environment override: the adapter's `dist/index.js`, optionally followed
/// by `:` and the Node binary to run it with.
pub const ADAPTER_ENV: &str = "THINGMAKER_CLAUDE_ACP";

/// What a Claude orchestrator runs on when the user has not chosen
/// (docs/plans/odyssey.md §12.9). Mirrored in the contracts so the picker and
/// the launch agree on one answer.
///
/// `claude-fable-5-1` is Fable's selection id as claude-agent-acp 0.84 lists
/// it (0.76 called it `claude-fable-5-1[1m]`). An adapter that does not offer
/// it, or an account that cannot select it, lands on the fallback, which is
/// the adapter's current Opus.
pub const CLAUDE_ORCHESTRATOR_MODEL: &str = "claude-fable-5-1";
pub const CLAUDE_ORCHESTRATOR_FALLBACK: &str = "opus";
pub const CLAUDE_ORCHESTRATOR_EFFORT: &str = "high";

/// The adapter's own id for a stance, as its `mode` config option lists it.
/// `plan` is the read-only one: `default` still edits once a human says yes,
/// and nothing here is going to say yes.
pub fn mode_id(stance: PermissionStance) -> &'static str {
    match stance {
        PermissionStance::AcceptEdits => "acceptEdits",
        PermissionStance::ReadOnly => "plan",
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeLaunchOptions {
    /// Canonical workspace root; also the child's working directory and the
    /// `cwd` of `session/new`.
    pub root: PathBuf,
    /// The interpreter installed beside the adapter.
    pub node: PathBuf,
    /// The adapter script first; nothing else is needed on the command line.
    pub args: Vec<String>,
    /// The id the desktop addresses this attachment by until the adapter
    /// answers with its own. A placeholder, but a stable one: the actor's
    /// handle and the duplicate-attachment check both read it, and they have
    /// to agree.
    pub reserved: SessionId,
    /// The model to select after the session opens, by the adapter's own id
    /// (`sonnet`, `opus`, `opus[1m]`, …). `None` leaves the account default.
    pub model: Option<String>,
    /// What to select when `model` cannot be — the adapter does not offer it,
    /// or refuses it because that model's own allowance is gone.
    ///
    /// Fable is the preferred orchestrator and is billed against usage
    /// credits rather than the subscription, so it is the one model that can
    /// run out while the account is otherwise fine. Without somewhere to
    /// land, a run would stop for a reason the account does not share.
    pub model_fallback: Option<String>,
    /// The reasoning effort to select, by the adapter's own id (`high`, …).
    pub effort: Option<String>,
    /// The adapter's session id to resume, from a previous run of this goal.
    pub resume: Option<String>,
    pub permission_mode: PermissionStance,
    /// Tools the session may not use, by Claude Code's names. An orchestrator
    /// whose workers are chosen by the desktop has `Agent` and `Task` here,
    /// so it delegates through the ThingMaker tools rather than starting
    /// Claude subagents the combo did not ask for.
    pub disallowed_tools: Vec<String>,
    /// Appended to Claude Code's own system prompt: an orchestrator's
    /// briefing on its team.
    pub append_system_prompt: Option<String>,
}

impl ClaudeLaunchOptions {
    pub fn new(root: impl Into<PathBuf>, node: impl Into<PathBuf>, args: Vec<String>) -> Self {
        Self {
            root: root.into(),
            node: node.into(),
            args,
            reserved: SessionId::reserve(),
            model: None,
            model_fallback: None,
            effort: None,
            resume: None,
            permission_mode: PermissionStance::ReadOnly,
            disallowed_tools: Vec::new(),
            append_system_prompt: None,
        }
    }

    /// The runtime arguments, which are just the configured ones: the adapter
    /// speaks ACP on stdio with no arguments at all, and everything the
    /// desktop wants to say about the session is said over the protocol.
    pub fn arguments(&self) -> Vec<String> {
        self.args.clone()
    }

    /// `_meta` for `session/new` and `session/load`: the Agent SDK options
    /// that have no config option. `None` when there is nothing to say, so a
    /// plain session's request stays plain.
    pub fn session_meta(&self) -> Option<serde_json::Value> {
        let mut meta = serde_json::Map::new();
        if !self.disallowed_tools.is_empty() {
            meta.insert("claudeCode".into(), serde_json::json!({ "options": { "disallowedTools": self.disallowed_tools } }));
        }
        // The adapter keeps Claude Code's preset and appends this to it.
        if let Some(append) = self.append_system_prompt.as_ref().filter(|text| !text.trim().is_empty()) {
            meta.insert("systemPrompt".into(), serde_json::json!({ "append": append }));
        }
        (!meta.is_empty()).then_some(serde_json::Value::Object(meta))
    }
}

/// Where the Claude adapter is and which Node runs it.
///
/// `configured` is the explicit choice from Settings, `(node, script)`.
/// Otherwise the environment override, then global npm installs — nvm's
/// newest Node first, then Homebrew and /usr/local — are searched for the
/// package. Nothing is guessed beyond that: a missing adapter is a message
/// that says how to install it, not a path that might work.
pub fn locate_adapter(
    home: &Path,
    configured: Option<(PathBuf, PathBuf)>,
    env_override: Option<String>,
) -> Result<(PathBuf, PathBuf), DesktopError> {
    if let Some((node, script)) = configured {
        return check_pair(node, script, "the adapter chosen in Settings");
    }
    if let Some(value) = env_override.filter(|value| !value.trim().is_empty()) {
        let (script, node) = match value.split_once(':') {
            Some((script, node)) => (PathBuf::from(script), Some(PathBuf::from(node))),
            None => (PathBuf::from(value.as_str()), None),
        };
        let node = node.or_else(|| node_beside(&script)).unwrap_or_else(|| PathBuf::from("/usr/bin/env"));
        return check_pair(node, script, ADAPTER_ENV);
    }
    for prefix in npm_prefixes(home) {
        let script = prefix.join("lib/node_modules").join(ADAPTER_PACKAGE).join(ADAPTER_ENTRY);
        if script.is_file() {
            let node = prefix.join("bin/node");
            if node.is_file() {
                return Ok((node, script));
            }
        }
    }
    Err(DesktopError::not_ready(format!(
        "Claude Code's ACP adapter is not installed. Install it with `npm install -g {ADAPTER_PACKAGE}`, or choose its dist/index.js in Settings."
    )))
}

fn check_pair(node: PathBuf, script: PathBuf, source: &str) -> Result<(PathBuf, PathBuf), DesktopError> {
    if !script.is_file() {
        return Err(DesktopError::not_ready(format!(
            "{source} names {}, which does not exist",
            script.display()
        )));
    }
    Ok((node, script))
}

/// `<prefix>/bin/node` for a script at `<prefix>/lib/node_modules/…`.
fn node_beside(script: &Path) -> Option<PathBuf> {
    let prefix = script.ancestors().find(|dir| dir.ends_with("lib/node_modules"))?.parent()?.parent()?;
    Some(prefix.join("bin/node")).filter(|node| node.is_file())
}

/// npm global prefixes, most likely first: nvm versions newest first, then
/// Homebrew and /usr/local.
fn npm_prefixes(home: &Path) -> Vec<PathBuf> {
    let mut nvm: Vec<(Vec<u64>, PathBuf)> = std::fs::read_dir(home.join(".nvm/versions/node"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let version = name
                .trim_start_matches('v')
                .split('.')
                .map(|part| part.parse::<u64>().ok())
                .collect::<Option<Vec<u64>>>()?;
            Some((version, entry.path()))
        })
        .collect();
    nvm.sort_by(|a, b| b.0.cmp(&a.0));
    let mut prefixes: Vec<PathBuf> = nvm.into_iter().map(|(_, path)| path).collect();
    prefixes.push(PathBuf::from("/opt/homebrew"));
    prefixes.push(PathBuf::from("/usr/local"));
    prefixes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trusted_workspace_accepts_edits_and_an_inspected_one_plans() {
        assert_eq!(mode_id(PermissionStance::AcceptEdits), "acceptEdits");
        assert!(PermissionStance::AcceptEdits.allows());
        // `plan` rather than `default`: `default` asks, and the only answer
        // this desktop can give on a read-only workspace is no.
        assert_eq!(mode_id(PermissionStance::ReadOnly), "plan");
        assert!(!PermissionStance::ReadOnly.allows());
    }

    #[test]
    fn the_adapter_is_launched_with_its_configured_arguments_and_nothing_else() {
        // The adapter speaks ACP on stdio with no flags; inventing some would
        // be a command line the adapter silently ignores.
        let options = ClaudeLaunchOptions::new("/work", "/usr/bin/node", vec!["/opt/adapter/dist/index.js".into()]);
        assert_eq!(options.arguments(), ["/opt/adapter/dist/index.js"]);
        assert_eq!(options.resume, None);
        assert_eq!(options.permission_mode, PermissionStance::ReadOnly, "the safe stance is the default");
    }

    #[test]
    fn an_orchestrator_that_may_not_start_subagents_says_so_in_session_meta() {
        let mut options = ClaudeLaunchOptions::new("/work", "/usr/bin/node", vec!["adapter.js".into()]);
        assert_eq!(options.session_meta(), None);
        options.disallowed_tools = vec!["Agent".into(), "Task".into()];
        assert_eq!(
            options.session_meta().unwrap(),
            serde_json::json!({"claudeCode": {"options": {"disallowedTools": ["Agent", "Task"]}}})
        );
        options.append_system_prompt = Some("You lead a team.".into());
        assert_eq!(options.session_meta().unwrap()["systemPrompt"], serde_json::json!({"append": "You lead a team."}));
    }

    fn install(prefix: &Path) -> PathBuf {
        let script = prefix.join("lib/node_modules").join(ADAPTER_PACKAGE).join(ADAPTER_ENTRY);
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(&script, "").unwrap();
        std::fs::create_dir_all(prefix.join("bin")).unwrap();
        std::fs::write(prefix.join("bin/node"), "").unwrap();
        script
    }

    #[test]
    fn the_newest_nvm_node_with_the_adapter_is_found() {
        let home = tempfile::tempdir().unwrap();
        let versions = home.path().join(".nvm/versions/node");
        install(&versions.join("v20.1.0"));
        let newest = install(&versions.join("v22.4.0"));
        std::fs::create_dir_all(versions.join("v24.0.0/bin")).unwrap();
        let (node, script) = locate_adapter(home.path(), None, None).unwrap();
        assert_eq!(script, newest);
        assert_eq!(node, versions.join("v22.4.0/bin/node"));
    }

    #[test]
    fn an_explicit_choice_or_override_wins_and_a_missing_adapter_says_how_to_install_it() {
        let home = tempfile::tempdir().unwrap();
        let script = install(&home.path().join("custom"));
        let (node, found) = locate_adapter(home.path(), None, Some(script.to_string_lossy().into_owned())).unwrap();
        assert_eq!(found, script);
        assert_eq!(node, home.path().join("custom/bin/node"));
        let chosen = locate_adapter(home.path(), Some(("/bin/node".into(), script.clone())), None).unwrap();
        assert_eq!(chosen.0, PathBuf::from("/bin/node"));
        let empty = tempfile::tempdir().unwrap();
        let error = locate_adapter(empty.path(), None, None);
        if let Err(error) = error {
            assert!(error.message.contains("npm install -g"), "{}", error.message);
        }
    }
}
