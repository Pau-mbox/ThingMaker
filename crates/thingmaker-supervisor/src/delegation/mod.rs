//! Delegation across providers: the piece that lets a Claude orchestrator
//! hand work to a Codex worker and the other way round
//! (docs/research/multi-provider-viability.md §2.2).
//!
//! Native subagent tools stay inside one provider, so every orchestrator
//! session gets a `thingmaker` MCP server instead. Its tools are answered here:
//!
//! - [`combo`]: the session's team and the router that picks a worker by
//!   name, capability and quota headroom;
//! - [`jobs`]: the service that opens worker sessions through the host, runs
//!   one turn per job and keeps the report;
//! - [`mcp`]: the MCP protocol over those;
//! - [`socket`]: the Unix socket the agent's MCP child connects back on, and
//!   the child itself.

pub mod combo;
pub mod jobs;
pub mod mcp;
pub mod socket;

pub use combo::{Combo, QuotaBook, WorkerSlot};
pub use jobs::{Delegation, JobStatus, JobView, WorkerLauncher, WorkerSpec};

/// What an orchestrator is told on top of the MCP server's own
/// instructions, in its system prompt (Claude) or developer instructions
/// (Codex).
pub fn orchestrator_guidance(native_withheld: bool) -> String {
    let mut text = String::from(
        "You are the orchestrator of a team in ThingMaker, the user's desktop for several AI providers. Besides your own tools you have the `team` MCP tools, which run workers on other providers and models the user chose for this session. \
Call `list_workers` before planning: the team can change during the session. Hand self-contained tasks to workers with `delegate`, choosing by capability (for example `image` for image generation, `fast` for quick mechanical work) and by the notes the user wrote. \
Delegate independent tasks together, then `await_jobs`. Workers share the workspace but not this conversation. You stay responsible for the goal: check each report, and the files it names, before relying on it.",
    );
    if native_withheld {
        text.push_str(" Your own subagent tool is turned off for this session: delegate through the `team` tools instead.");
    }
    text
}
