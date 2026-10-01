//! Trust, execution profiles and the launch environment (spec section 16).
//!
//! R1 is explicitly **Trusted local - host access**: the agent process runs with
//! the user's full OS authority and Tauri capabilities do not constrain it.
//! The UI must show this honestly (ADR-07); nothing here claims sandboxing.

pub mod env_profile;

use serde::{Deserialize, Serialize};

pub use env_profile::EnvironmentProfile;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionProfile {
    /// Desktop does not start agents, PTYs, project hooks or executable previews.
    InspectOnly,
    /// Normal OS user authority with selected credentials and environment.
    TrustedLocal,
    /// Certified container/VM boundary. R2; disabled until its gate passes.
    RestrictedEnvironment,
    /// Remote host enforces policy and authentication. R3.
    RemoteManaged,
}

impl ExecutionProfile {
    /// Profiles that may actually execute in the R1 baseline.
    pub fn available_in_r1(self) -> bool {
        matches!(self, Self::InspectOnly | Self::TrustedLocal)
    }

    /// User-facing label. The trusted-local wording is deliberate: it is not
    /// a "safe workspace mode".
    pub fn label(self) -> &'static str {
        match self {
            Self::InspectOnly => "Inspect only - no agent execution",
            Self::TrustedLocal => "Trusted local - host access",
            Self::RestrictedEnvironment => "Restricted environment (not available in this release)",
            Self::RemoteManaged => "Remote managed (not available in this release)",
        }
    }

    pub fn explanation(self) -> &'static str {
        match self {
            Self::InspectOnly => {
                "Browse permitted files and cached history. Agents, terminals, project hooks and previews are not started."
            }
            Self::TrustedLocal => {
                "Agents run with your full user account authority. Their shell, edit and MCP tools can read and write outside the workspace root and reach the network. The desktop does not mediate those tools; review the workspace's executable configuration before trusting it."
            }
            Self::RestrictedEnvironment => {
                "Requires a certified isolated runner with mount and egress policy. Its security tests have not passed for this release, so it stays disabled."
            }
            Self::RemoteManaged => {
                "Requires an authenticated remote environment with its own policy enforcement. Not provisioned in this release."
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_local_profiles_are_available_in_r1() {
        assert!(ExecutionProfile::TrustedLocal.available_in_r1());
        assert!(ExecutionProfile::InspectOnly.available_in_r1());
        assert!(!ExecutionProfile::RestrictedEnvironment.available_in_r1());
        assert!(!ExecutionProfile::RemoteManaged.available_in_r1());
        assert_eq!(ExecutionProfile::TrustedLocal.label(), "Trusted local - host access");
        assert!(!ExecutionProfile::TrustedLocal.explanation().to_lowercase().contains("safe"));
    }
}
