//! Claude Code, through `claude-agent-acp`.
//!
//! The adapter is a complete ACP agent: it resumes sessions, has permission
//! modes, steers a running turn, reports rate limits and reads the same
//! `~/.agents/skills` the odyssey skill installs into. So the protocol is
//! ordinary ACP, handled by the same session actor as every provider; what is
//! here is only what is Claude's own: the launch contract (`launch`), where
//! the transcript lives and what it says (`transcript_usage`), how a subagent
//! appears on the stream (`subagents`), and what the account says about its
//! quota (`quota`).
//!
//! Pinned against adapter 0.76.0, whose shape the code below depends on,
//! verified against the running adapter rather than read off a README:
//!
//! - it negotiates ACP protocol version 1, names itself in `agentInfo` and
//!   its capabilities in `agentCapabilities`;
//! - the client chooses nothing about the session id: `session/new` returns a
//!   UUID and `session/load` takes it back;
//! - message chunks carry no `messageId`;
//! - `usage_update` carries `_meta["_claude/rateLimit"]`, the SDK's
//!   `rate_limit_info` (`status`, `resetsAt`, `rateLimitType`, `utilization`),
//!   when that state changes — a sparse signal, not one per turn.

pub mod auth;
pub mod launch;
pub mod quota;
pub mod subagents;
pub mod transcript_usage;
pub mod usage_probe;

pub use launch::ClaudeLaunchOptions;
pub use quota::{RateLimit, quota_from_usage_meta, rate_limit_from_error};
