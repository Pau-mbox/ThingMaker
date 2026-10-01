# ADR-009: Providers run through their own official programs, on subscriptions

**Status:** Accepted (30 September 2026).

## Decision

Every provider is driven through the program its vendor ships for that
purpose, unmodified, as an out-of-process child over stdio:

- Claude Code through `claude-agent-acp` (ACP v1);
- Codex through `codex app-server`, translated to ACP inside the supervisor.

The user signs in through the provider's own flow, on their subscription. The
desktop never reads, stores, refreshes or forwards a provider token, and never
calls a provider's private backend itself. There is no API-key path.

Adding a provider is one `Provider` variant, one `AgentLaunch` variant and one
module under `agents/`. A CLI that speaks ACP needs only its launch contract;
one that does not gets a bridge in the supervisor.

## Why

This is the line every provider's terms now draw (checked 30 September 2026):
running the unmodified official program with the user's own sign-in is
allowed, and harnesses that extract OAuth tokens to call private endpoints
have been blocked and their accounts banned.

## Consequences

- Features exist only where the official program exposes them. Quota comes
  from what each program reports (Claude's per-turn rate-limit event and
  refusals, Codex's rate-limit methods), not from a usage endpoint.
- Each provider's own configuration (MCP servers, skills, instruction files)
  applies to its sessions; the desktop edits the shared, file-based parts and
  injects per-session servers through the protocol rather than rewriting the
  user's configuration.
- The environment profile drops every `ANTHROPIC_*`, `CLAUDE_*`, `OPENAI_*` and
  `CODEX_*` variable, so an agent signs in as the account its own login
  names.
