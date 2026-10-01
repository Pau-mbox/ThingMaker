//! Documented launch environment for every agent (F13).
//!
//! Copying the whole parent environment helps tool discovery but exposes every
//! ambient credential to the agent and its MCP servers. This profile inherits
//! a documented baseline (PATH, locale, temp, proxy and TLS settings) and adds
//! explicitly allowlisted names. Everything else is dropped — notably every
//! `ANTHROPIC_*`, `CLAUDE_*`, `OPENAI_*` and `CODEX_*` variable, so an agent
//! signs in as the account its own login names, not as whatever a developer
//! shell happened to export. Provider-specific values the desktop means to
//! pass (a `CODEX_HOME` for a second account, say) are set explicitly.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Variables always inherited when present.
pub const BASELINE_INHERITED: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "TERM",
    "TZ",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    // Windows essentials; harmless elsewhere.
    "SYSTEMROOT",
    "SystemRoot",
    "COMSPEC",
    "ComSpec",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "PATHEXT",
    "WINDIR",
];

/// Prefixes always inherited.
pub const BASELINE_PREFIXES: &[&str] = &["LC_", "XDG_"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentProfile {
    pub name: String,
    pub inherit_names: Vec<String>,
    pub inherit_prefixes: Vec<String>,
    /// Extra variables the user explicitly allowed (for example a provider
    /// API key needed by a configured MCP server).
    pub allow_names: Vec<String>,
    /// Variables set to fixed values, overriding anything inherited.
    pub set: BTreeMap<String, String>,
}

impl EnvironmentProfile {
    pub fn trusted_local() -> Self {
        Self {
            name: "trusted-local".into(),
            inherit_names: BASELINE_INHERITED.iter().map(|s| s.to_string()).collect(),
            inherit_prefixes: BASELINE_PREFIXES.iter().map(|s| s.to_string()).collect(),
            allow_names: Vec::new(),
            set: BTreeMap::new(),
        }
    }

    pub fn allow(mut self, name: impl Into<String>) -> Self {
        self.allow_names.push(name.into());
        self
    }

    pub fn with_set(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.set.insert(name.into(), value.into());
        self
    }

    /// Computes the child environment from the parent's variables.
    pub fn resolve(
        &self,
        parent: impl IntoIterator<Item = (String, String)>,
    ) -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        for (name, value) in parent {
            let inherited = self.inherit_names.iter().any(|n| n == &name)
                || self.allow_names.iter().any(|n| n == &name)
                || self.inherit_prefixes.iter().any(|prefix| name.starts_with(prefix));
            if inherited {
                env.insert(name, value);
            }
        }
        for (name, value) in &self.set {
            env.insert(name.clone(), value.clone());
        }
        env
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parent() -> Vec<(String, String)> {
        [
            ("PATH", "/usr/bin:/bin"),
            ("HOME", "/Users/me"),
            ("LC_ALL", "en_US.UTF-8"),
            ("ANTHROPIC_BASE_URL", "http://proxy"),
            ("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat"),
            ("OPENAI_API_KEY", "sk-proj"),
            ("AWS_SECRET_ACCESS_KEY", "secret"),
            ("GITHUB_TOKEN", "ghp_secret"),
            ("OPENROUTER_API_KEY", "sk-or"),
            ("XDG_CONFIG_HOME", "/Users/me/.config"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    #[test]
    fn baseline_keeps_discovery_variables_and_drops_ambient_secrets() {
        let env = EnvironmentProfile::trusted_local().resolve(parent());
        assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin:/bin"));
        assert_eq!(env.get("LC_ALL").map(String::as_str), Some("en_US.UTF-8"));
        assert_eq!(env.get("XDG_CONFIG_HOME").map(String::as_str), Some("/Users/me/.config"));
        assert!(!env.contains_key("AWS_SECRET_ACCESS_KEY"));
        assert!(!env.contains_key("GITHUB_TOKEN"));
        assert!(!env.contains_key("OPENROUTER_API_KEY"));
        // A developer shell's provider routing never reaches an agent: it
        // would sign the agent in as a different account than its own login.
        assert!(!env.contains_key("ANTHROPIC_BASE_URL"));
        assert!(!env.contains_key("CLAUDE_CODE_OAUTH_TOKEN"));
        assert!(!env.contains_key("OPENAI_API_KEY"));
        // Fixed values override inherited ones.
        let set = EnvironmentProfile::trusted_local().with_set("HOME", "/elsewhere").resolve(parent());
        assert_eq!(set.get("HOME").map(String::as_str), Some("/elsewhere"));
    }

    #[test]
    fn explicit_allowlist_forwards_named_variables() {
        let env = EnvironmentProfile::trusted_local()
            .allow("OPENROUTER_API_KEY")
            .resolve(parent());
        assert_eq!(env.get("OPENROUTER_API_KEY").map(String::as_str), Some("sk-or"));
        assert!(!env.contains_key("GITHUB_TOKEN"));
    }
}
