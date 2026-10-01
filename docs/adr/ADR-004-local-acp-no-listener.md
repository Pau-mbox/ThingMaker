# ADR-004: Agents are driven locally, with no network listener

**Status:** Accepted.

## Decision

Every agent is a child process of the supervisor, spoken to over its own
stdio: Claude Code through `claude-agent-acp`, Codex through `codex
app-server`, Gemini through Antigravity's `agy`. ThingMaker never starts a
provider's server mode and never opens a TCP port.

Delegation needs one channel back in. An orchestrator's agent starts the
`team` MCP server as its own stdio child, and that child has to reach the
supervisor. It connects to a Unix socket in the app's data directory
(`delegation::socket`), mode 0600, and is served only after it presents the
per-session token from its environment. An unknown token gets one error line
and the connection closes.

## Consequences

- No agent, and nothing else on the network, can drive a session from
  outside: the socket is local and token-gated.
- The `team` relay is the ThingMaker executable itself, started with
  `--thingmaker-mcp`; nothing extra is bundled.
