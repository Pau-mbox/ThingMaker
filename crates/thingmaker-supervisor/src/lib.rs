//! ThingMaker native supervisor.
//!
//! This crate is the privileged engine behind the Tauri host (spec ADR-03). It
//! owns agent processes, ACP transport parsing, provider bridges, session
//! state machines, durable desktop metadata and the environment/trust policy.
//! The renderer never talks to an agent directly; it receives typed commands
//! and ordered event envelopes produced here.
//!
//! Module map:
//!
//! - [`transport`]: newline-delimited JSON-RPC framing over stdio with bounded
//!   buffers, request correlation and process lifecycle.
//! - [`acp`]: the ACP v1 client: capability negotiation and `session/update`
//!   decoding with exact absence/null/replacement semantics.
//! - [`agents`]: the providers (Claude Code, Codex) and everything about them
//!   that is not ordinary ACP: launch contracts, subagent and quota
//!   translation, transcripts.
//! - [`delegation`]: the ThingMaker MCP server, the team (combo) and the jobs
//!   an orchestrator hands to workers on any provider.
//! - [`supervisor`]: session actors, state machines and the event envelope.
//! - [`storage`]: transactional SQLite metadata with migrations, drafts and the
//!   submission outbox.
//! - [`workspace`]: canonical workspace identity.
//! - [`security`]: execution profiles and the launch environment allowlist.
//! - [`review`]: content-addressed baselines and diff scopes for the review
//!   workspace (Git optional).
//! - [`terminal`]: native PTY service for the interactive terminal (never used
//!   for ACP, which stays on plain pipes).
//! - [`integrations`]: MCP servers, skills and instruction files with
//!   provenance and comment-preserving edits.
//! - [`attachments`]: sniffed, bounded, content-addressed prompt media and
//!   file mentions.
//! - [`artifacts`]: versioned references to produced content with provenance.

pub mod artifacts;
pub mod attachments;
pub mod c2pa;
pub mod delegation;
pub mod error;
pub mod ids;
pub mod integrations;
pub mod acp;
pub mod agents;
pub mod odyssey_check;
pub mod odyssey_checkpoint;
pub mod odyssey_notes;
pub mod odyssey_spend;
pub mod review;
pub mod security;
pub mod storage;
pub mod bigthing;
pub mod supervisor;
pub mod terminal;
pub mod transport;
pub mod workspace;

pub use error::{DesktopError, ErrorCode, RetryPolicy};
pub use ids::{DecimalId, SessionHandle};

/// Desktop API version carried in every event envelope (spec section 20.1).
pub const DESKTOP_API_VERSION: u32 = 1;
