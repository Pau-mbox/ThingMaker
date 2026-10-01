//! Gemini, through Antigravity's official CLI, `agy`.
//!
//! `agy` speaks newline-delimited JSON events rather than ACP or JSON-RPC, so
//! the session actor reaches it through [`bridge::GeminiBridge`]. What is
//! Antigravity's own lives here: the launch contract (`launch`), the bridge,
//! and one-shot account questions (`probe`: sign-in and models).
//!
//! A Gemini session is a worker or a plain session, never an orchestrator:
//! `agy` takes MCP servers only from its global configuration, so it cannot
//! be handed a session's own `team` server.
//!
//! Pinned against `agy` 1.2.14 (1 October 2026); see the S3 results in
//! docs/research/multi-provider-viability.md §7.

pub mod bridge;
pub mod launch;
pub mod probe;

pub use launch::GeminiLaunchOptions;
