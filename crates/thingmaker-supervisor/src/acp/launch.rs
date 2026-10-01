//! Launch plumbing shared by every agent (spec section 8.1, ADR-04).
//!
//! Agents are launched over stdio only, never with a listener (F08).
//! Arguments are an explicit vector, never shell text.

use std::{collections::BTreeMap, fmt, path::{Path, PathBuf}};


use serde::{Deserialize, Serialize};

use crate::{error::DesktopError, security::EnvironmentProfile, transport::LaunchSpec};

/// Session identifiers the desktop addresses: 1-128 ASCII letters, digits,
/// `-` or `_`. Agents' own ids (UUIDs) fit.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(String);

impl SessionId {
    pub const MAX_LEN: usize = 128;

    pub fn new(value: impl Into<String>) -> Result<Self, DesktopError> {
        let value = value.into();
        if value.is_empty() || value.len() > Self::MAX_LEN {
            return Err(DesktopError::protocol(format!(
                "session id must be 1-{} characters",
                Self::MAX_LEN
            )));
        }
        if !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err(DesktopError::protocol(
                "session id may contain only ASCII letters, digits, '-' and '_'",
            ));
        }
        Ok(Self(value))
    }

    /// Reserves a fresh desktop-originated identifier before launch.
    pub fn reserve() -> Self {
        Self(format!("tm-{}", uuid::Uuid::new_v4().simple()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for SessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The executable plus fixed prefix arguments. Production runs the agent
/// with no prefix. Tests use `python3 <mock> [flags]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchTarget {
    pub executable: PathBuf,
    pub prefix_args: Vec<String>,
}

impl LaunchTarget {
    pub fn executable(path: impl Into<PathBuf>) -> Self {
        Self {
            executable: path.into(),
            prefix_args: Vec::new(),
        }
    }
}

/// Combines target, runtime arguments and the environment profile into a
/// launch spec. `parent_env` is the desktop's own environment; the profile
/// decides what the agent receives (F13).
pub fn launch_spec(
    target: &LaunchTarget,
    runtime_args: Vec<String>,
    cwd: &Path,
    profile: &EnvironmentProfile,
    parent_env: impl IntoIterator<Item = (String, String)>,
) -> LaunchSpec {
    let mut args = target.prefix_args.clone();
    args.extend(runtime_args);
    let env: BTreeMap<String, String> = profile.resolve(parent_env);
    LaunchSpec {
        program: target.executable.clone(),
        args,
        cwd: cwd.to_path_buf(),
        env,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_session_ids() {
        assert!(SessionId::new("d847b2a3-c7b5-4459-8b0f-02fdd03031a4").is_ok());
        assert!(SessionId::new("A_b-9").is_ok());
        assert!(SessionId::new("").is_err());
        assert!(SessionId::new("has space").is_err());
        assert!(SessionId::new("dots.are.bad").is_err());
        assert!(SessionId::new("x".repeat(128)).is_ok());
        assert!(SessionId::new("x".repeat(129)).is_err());
        let reserved = SessionId::reserve();
        assert!(reserved.as_str().starts_with("tm-"));
        assert!(SessionId::new(reserved.as_str()).is_ok());
    }

    #[test]
    fn launch_spec_prefixes_target_arguments_and_resolves_environment() {
        let target = LaunchTarget {
            executable: PathBuf::from("/usr/bin/python3"),
            prefix_args: vec!["mock.py".into(), "--steer".into()],
        };
        let profile = EnvironmentProfile::trusted_local();
        let spec = launch_spec(
            &target,
            vec!["acp".into()],
            Path::new("/work"),
            &profile,
            vec![
                ("PATH".to_string(), "/bin".to_string()),
                ("AWS_SECRET_ACCESS_KEY".to_string(), "nope".to_string()),
            ],
        );
        assert_eq!(spec.args, ["mock.py", "--steer", "acp"]);
        assert_eq!(spec.env.get("PATH").map(String::as_str), Some("/bin"));
        assert!(!spec.env.contains_key("AWS_SECRET_ACCESS_KEY"));
    }
}
