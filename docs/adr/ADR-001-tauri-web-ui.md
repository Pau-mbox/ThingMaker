# ADR-001: Tauri 2 host with a React web UI

**Status:** Accepted (baseline). **Spec:** ADR-01, section 6.

## Decision

Use Tauri 2 for desktop packaging and native integration and React with strict
TypeScript (Vite) for the interface. Use the platform webview; do not bundle
Chromium.

## Consequences

- Webview engines differ per OS, so platform testing is mandatory and smaller
  packaging is not proof of lower total memory or identical rendering.
- The renderer is a trusted application origin with a restrictive CSP and
  minimal per-window capabilities; artifact previews get a separate,
  unprivileged origin (spec ART-03, SEC-10).
- Frontend state (Zustand, TanStack Query) is presentation state only; the
  native supervisor is the authority for session state.

## Repository mapping

`apps/desktop` (Tauri host + React), `packages/contracts` (shared types and
pinned schemas), `packages/ui` (design system, later).
