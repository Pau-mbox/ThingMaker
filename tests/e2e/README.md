# Native end-to-end tests

Reserved for WebdriverIO + Tauri service tests (spec section 21.2, T05).
Nothing runs here yet: the R0 gates are covered by

- `crates/thingmaker-supervisor/tests/*_peer.rs` (each provider against its
  captured mock) and the gated `real_*.rs` smoke tests against the real programs,
- `apps/desktop/src/*.test.ts` and `packages/contracts/test` (renderer
  projection and contracts).

When WDIO tests are added, the embedded WebDriver server and any native mocking
plugins must be compiled only into dedicated test builds, and release tests must
verify those listeners are absent (spec section 21.2).
