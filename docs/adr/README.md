# Architecture decision records

The decisions ThingMaker is built on. Each record is short by design; the code
holds the tests that protect the decision.

| ADR | Title | Status |
| --- | --- | --- |
| [ADR-001](ADR-001-tauri-web-ui.md) | Tauri 2 host with a React web UI | Accepted |
| [ADR-003](ADR-003-rust-owns-privileged-work.md) | Rust owns privileged work | Accepted |
| [ADR-004](ADR-004-local-acp-no-listener.md) | Agents are driven locally, with no network listener | Accepted |
| [ADR-007](ADR-007-convenience-vs-enforcement.md) | Distinguish convenience from enforcement | Accepted |
| [ADR-009](ADR-009-providers-through-official-programs.md) | Providers run through their own official programs, on subscriptions | Accepted |

The missing numbers belong to records from the runtime ThingMaker started on,
retired when it moved to Claude Code, Codex and Gemini.

Any change that adds model-visible tools, hides a runtime capability or changes
credential authority requires a new or amended record.
