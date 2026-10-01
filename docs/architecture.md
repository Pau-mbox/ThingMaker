# ThingMaker architecture

The technical companion to the [README](../README.md): how the app is built,
what each provider runs, and where things live.

Tauri 2 host, React/TypeScript interface, and a Rust supervisor that drives
each provider's **own official program** out of process:

| Provider | Program | Protocol | Signs in with |
| --- | --- | --- | --- |
| Claude Code | `claude-agent-acp` (Anthropic's Agent SDK over ACP) | ACP v1 | Claude Pro, Max, Team or Enterprise |
| Codex | `codex app-server` | Codex app-server JSON-RPC, bridged to ACP inside the supervisor | ChatGPT plan |
| Gemini (worker or plain session) | Antigravity CLI `agy` (`stream-json` mode) | NDJSON events, bridged to ACP inside the supervisor | Google account (Antigravity quota), shared with the Antigravity app |

Subscriptions only, never API keys. The desktop never reads, stores or passes
on a provider token: each program signs in through its provider's own flow and
keeps its credentials in its own store. Decisions are in
[`docs/adr`](adr/README.md); the providers' terms behind them are summarised in
[ADR-009](adr/ADR-009-providers-through-official-programs.md).


## Status by provider and feature

Kit is removed; Claude Code and Codex run end to end and either can orchestrate the other; Gemini runs as a worker or a plain session.

- **Supervisor** (`crates/thingmaker-supervisor`): stdio JSON-RPC transport; an
  ACP v1 client (`acp`) with capability negotiation and `session/update`
  decoding; providers (`agents`) with their launch contracts, sign-in, model
  catalogs, subagent and quota translation into provider-neutral events, and
  transcript usage readers; session actors, SQLite storage, review, git,
  worktrees, terminal, attachments, artifacts, skills and instruction files.
- **Claude Code**: sessions, resume (`session/load`), steering
  (`_session/steering`), quota (`_claude/rateLimit` → `Quota` events, sent
  only when the limit state changes), subagents from `Agent`/`Task` calls,
  transcript token usage, streamed subscription sign-in and the account's model
  catalog.
- **Codex**: `codex app-server` bridged to ACP inside the supervisor
  (`agents::codex::bridge`). Threads are sessions, with resume, steering
  (`turn/steer`) and interrupt. Approvals are answered from workspace trust.
  Rate limits arrive as `Quota` events on every turn, and a spent account fails
  the turn as `rate_limit`. Also: collab subagents, rollout token usage,
  `codex login` sign-in, `model/list` and `account/rateLimits/read`.
- **Gemini** (`agents::gemini`): Antigravity's official `agy` in `stream-json`
  mode, bridged to ACP.
  - One process per conversation, resumed with `--conversation`. A model,
    effort or mode change relaunches it between turns, and so does a cancel,
    because SIGINT ends the process.
  - A trusted workspace runs `--mode accept-edits
    --dangerously-skip-permissions` (headless `agy` otherwise refuses every
    shell command); an inspected one runs `--mode plan`.
  - Models come from `agy models`.
  - No steering and no quota signal: a spent account shows as a refused turn.
  - **A worker or a plain session, never an orchestrator.** `agy` reads MCP
    servers only from its global configuration, so it cannot take a session's
    own `team` server.
- **Accounts**: the Providers panel's **Switch account** signs a provider out
  through its own CLI, then starts a new sign-in. The launch options also accept
  a separate `CODEX_HOME` for each Codex account; the UI does not offer that yet.
- **Odyssey** runs on either provider, with N-provider failover.
- **Teams and delegation** (`delegation`): every session is an orchestrator.
  - Its agent gets a `team` MCP server with `list_workers`, `delegate`,
    `await_jobs`, `job_status` and `cancel_job`.
  - Workers are sessions on any provider and model. The **team** button beside
    the model picker opens the session's team panel: pick a preset or edit the
    orchestrator and workers directly. The team can change mid-session.
  - **Teams** (the icon beside Settings) keeps presets: an orchestrator
    (provider, model, effort) and its workers. One preset can be the default
    for new sessions, and any preset can start a session from the workspace
    view.
  - Routing goes by worker name, then capability, then quota headroom. A
    worker refused for its limit before doing any work hands its job on.
  - Jobs show in the Agents view, and worker sessions sit under their
    orchestrator in the sidebar.
  - Switching the orchestrator to the other provider is a handoff: a new
    session with the same team and a brief in its composer.

Next steps:

- Smarter routing between providers, with a spread policy so no one account is drained.
- Shared project memory and a live board the whole team reads and writes.

## Layout

```text
apps/desktop/                 Tauri 2 app: src/ (React), src-tauri/ (thin command layer)
crates/thingmaker-supervisor/  privileged engine: transport, acp, agents, supervisor, storage, review, workspace, security
packages/contracts/           desktop API TypeScript types (mirror the supervisor's serde output)
packages/test-fixtures/       mock ACP peers for the providers, captured from the real programs
runtime/skills, runtime/agents  the Odyssey skill and the Claude Code delegate definition
docs/                         architecture, decisions (adr/), release notes
```

## Prerequisites (development)

- Rust stable (see `rust-toolchain.toml`); Xcode command line tools on macOS.
- Node 22.12+ (Node 24 LTS via nvm is used; `.nvmrc`) and pnpm 10. jsdom rejects Node 25.
- Python 3 for the mock ACP peers used by tests.
- **Claude Code:** `npm install -g @agentclientprotocol/claude-agent-acp`
  (found under nvm, Homebrew or /usr/local, or set `THINGMAKER_CLAUDE_ACP` to
  its `dist/index.js`, or choose it in Providers).
- **Codex:** the `codex` CLI on PATH, or the ChatGPT app (its bundled
  `codex-cli` is found automatically), or `THINGMAKER_CODEX`.

## Commands

```bash
cargo test --workspace --exclude thingmaker-desktop
```

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

```bash
pnpm install && pnpm typecheck && pnpm test
```

```bash
pnpm dev
```

## Look and feel

The window uses an overlay title bar (macOS traffic lights sit over the
sidebar header, which is a drag region), a collapsible sidebar (⌘B) with
workspace groups, session rows tagged with the provider they spend, hover
actions (pin, archive, rename), an "Archived (N)" disclosure, and a footer
with each provider's quota and quick access to Providers and Settings. Every
session is durable in its agent's own transcript; "archive" hides a session
from the list and is reversible, never a deletion.

## Renderer hardening notes

The WebView runs under a strict CSP (`script-src 'self'`, workers from our own
origin only, IPC as the sole connect target). Tauri's `freezePrototype` is
deliberately off: freezing `Object.prototype` makes the common
`namespace.toString = fn` pattern throw in strict mode (xterm.js does this at
module load, blanking the window), and the CSP already prevents foreign script
from reaching the page.

## Non-goals

No API-key billing, no reading or proxying provider tokens, no rotation across
several accounts of one provider to get past its limits, no TUI scraping, no
hidden model calls behind deterministic buttons, no claims of sandboxing.
