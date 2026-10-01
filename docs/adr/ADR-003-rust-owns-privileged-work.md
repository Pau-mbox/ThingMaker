# ADR-003: Rust owns privileged work

**Status:** Accepted (baseline). **Spec:** ADR-03, sections 7, 20.1.

## Decision

A Rust/Tokio supervisor owns child processes, transport parsing, filesystem
handles, Git operations, terminals, local storage and native approvals. React
receives typed commands and ordered, bounded event channels. No arbitrary
shell execution, unrestricted filesystem access or generic JSON-RPC forwarding
is exposed to the renderer.

## Implementation

The supervisor lives in `crates/workbench-supervisor` so it is testable
without a Tauri build. Its module names match the specification's proposed
`src-tauri/src/*` layout (`transport`, `kit_adapter`, `supervisor`, `storage`,
`workspace`, `security`). The Tauri crate under `apps/desktop/src-tauri`
contains only the narrow command layer that maps to supervisor calls.

## Consequences

- Inputs are validated in Rust even when TypeScript types exist (SEC-10).
- Every command resolves exactly once with a result or a typed
  `DesktopError` (F11).
- Session actors outlive UI navigation (F01, ARCH-02).
