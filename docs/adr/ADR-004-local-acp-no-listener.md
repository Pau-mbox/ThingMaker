# ADR-004: Agents use local provider transport

**Status:** Accepted for provider transport; amended for the local
Windows/Android adaptation on 2026-10-03 by [ADR-011](ADR-011-shared-android-remote-ui.md).

## Decision

Every agent is a child process of the supervisor, spoken to over its own
stdio: Claude Code through `claude-agent-acp`, Codex through `codex
app-server`, Gemini through Antigravity's `agy`. ThingMaker never starts a
provider's network server mode. Provider transport does not open a TCP port.
The local Android adaptation separately exposes authenticated remote control
on loopback, described in ADR-011; it reuses these same local agent processes.

Delegation needs one channel back in. An orchestrator's agent starts the
`team` MCP server as its own stdio child, and that child has to reach the
supervisor. On Unix it connects to a Unix socket in the app's data directory
(`delegation::socket`), mode 0600, and is served only after it presents the
per-session token from its environment. An unknown token gets one error line
and the connection closes.

On Windows the relay uses an owner-only local named pipe that rejects remote
clients, retaining per-session token authentication.

## Consequences

- The delegation channel is local and token-gated. Remote Android control
  crosses a separate authenticated boundary, not this delegation socket.
- The `team` relay is the ThingMaker executable itself, started with
  `--thingmaker-mcp`; nothing extra is bundled.
