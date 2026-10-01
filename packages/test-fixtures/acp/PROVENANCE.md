# ACP mock peers

`mock-claude-acp.py` is ours. It answers the way `claude-agent-acp` 0.76.0
answered when captured: ACP protocol version 1, `agentInfo` /
`agentCapabilities`, a UUID from `session/new`, `session/load` for resume,
config options for model/mode/effort, and a `session/prompt` that resolves
with the finished turn's `stopReason`. The flags the tests rely on are
documented in `crates/workbench-supervisor/tests/claude_peer.rs`.
