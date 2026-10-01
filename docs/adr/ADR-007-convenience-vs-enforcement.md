# ADR-007: Distinguish convenience from enforcement

**Status:** Accepted (baseline). **Spec:** ADR-07, section 16, F14, PLAN-02.

## Decision

Worktrees isolate working copies, not host access. Tauri capabilities
constrain the renderer, not the agents' child processes. A plan instruction is not a
read-only policy. R1 is labelled **Trusted local - host access** and never
"safe workspace mode".

## Implementation

- `security::ExecutionProfile` carries the honest labels and marks restricted
  and remote profiles unavailable in R1.
- `security::EnvironmentProfile` documents exactly which variables the helper
  inherits; ambient credentials are dropped unless explicitly allowed (F13).
- `session/request_permission` is answered with a deterministic `cancelled`
  outcome and surfaced as an event; no consent is inferred (F14, SEC-07).

## Consequences

Per-tool approvals, sandboxing and read-only modes stay disabled until their
enforcement path exists and its tests pass (spec section 16.3 and 20.2, X03).
