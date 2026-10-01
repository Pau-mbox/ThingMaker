//! Codex, through `codex app-server`.
//!
//! Codex speaks its own JSON-RPC protocol rather than ACP, so the session
//! actor reaches it through [`bridge::CodexBridge`], which translates each way
//! inside the supervisor. What is Codex's own lives here: the launch contract
//! (`launch`), the bridge, one-shot account questions (`probe`: sign-in,
//! models, quota), quota translation (`quota`), subagents (`subagents`) and
//! the transcript reader (`transcript_usage`).
//!
//! Pinned against `codex` 0.158.0-alpha.2 as shipped in the ChatGPT app
//! (30 September 2026); the protocol was read from its own
//! `app-server generate-ts --experimental` output.

pub mod bridge;
pub mod launch;
pub mod probe;
pub mod quota;
pub mod subagents;
pub mod transcript_usage;

pub use launch::CodexLaunchOptions;
