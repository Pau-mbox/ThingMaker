//! The ACP client: the desktop's side of the Agent Client Protocol (v1).
//!
//! Every provider is driven through this one client. Agents that speak ACP
//! themselves (`claude-agent-acp`) are attached directly; agents with their
//! own protocol are reached through a bridge inside the supervisor that
//! translates it into ACP (`agents::codex`). Unknown but well-formed data is
//! preserved, never dropped (F10).

pub mod capabilities;
pub mod errors;
pub mod launch;
pub mod updates;

pub use capabilities::CapabilitySnapshot;
pub use launch::{LaunchTarget, SessionId};
pub use updates::{ContentBlock, MessageUpdate, SessionUpdate, ToolPatch};

/// Name/version the desktop advertises in `initialize.clientInfo`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientIdentity {
    pub name: String,
    pub title: String,
    pub version: String,
}

impl Default for ClientIdentity {
    fn default() -> Self {
        Self {
            name: "thingmaker".into(),
            title: "ThingMaker".into(),
            version: env!("CARGO_PKG_VERSION").into(),
        }
    }
}

/// The ACP protocol version the desktop negotiates (PRO-01).
pub const PROTOCOL_VERSION: u64 = 1;
