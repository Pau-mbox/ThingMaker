# ADR-011: Shared Android UI over authenticated WebSocket

**Status:** Accepted in this checkout's local Windows/Android adaptation.
**Date:** 2026-10-03.

## Decision

Bundle the desktop React renderer in the Android APK. Keep HTTPS/API-key
onboarding, encrypted credentials, file pickers and connectivity in native
Kotlin. Use `bridge.ts` to select Tauri IPC on desktop or the Android native
message bridge on mobile, without duplicating the conversation UI.

The Tauri host listens on `127.0.0.1:18420`. Native OkHttp sends authenticated
commands to `/v2/ws` through the existing managed Cloudflare tunnel and SSH
reverse forward. Rust explicitly dispatches the same typed commands against
the existing `AppState`, supervisor and session actors. REST `/v1` remains
compatible with the first Android release.

The PC generates a remote-control key independently of provider sign-in.
Android encrypts it using Android Keystore. Only native code owns the Bearer
header; the key is absent from the bundled renderer, JavaScript storage and URL.
WebViewAssetLoader serves a dedicated local HTTPS origin, and the message bridge
accepts only that origin's main frame. Key rotation revokes live sockets.

## Consequences

- PC and mobile share projects, conversations and live actors. Android is a
  controller; agents, files and terminals execute under the PC user's authority.
  This key grants substantial control of that host, rather than read-only access.
- A finite generated command allowlist replaces arbitrary host reflection.
  Key generation, app quit and unsupported native dialogs remain desktop-only.
- Session events, terminal output and job/Big Thing notifications are pushed.
  Output queues and concurrent commands are bounded; a lagging connection closes
  and reconciles rather than silently dropping transcript events.
- Disconnecting releases subscriptions while accepted work can finish on the PC.
  Uncertain writes are rejected locally and never automatically resubmitted.
  Reconnection restores subscriptions and reconciles snapshots and retained
  history. A PC restart requires explicit resume of stale sessions.
- Shared source does not mean identical platform packaging: native dialogs and
  provider sign-in still need the PC, while Android supplies touch layouts and
  its own file-selection/export flows.

This amends ADR-004's blanket no-listener statement without changing local
provider transport or the subscription-only decision in ADR-009. Deployment
and validation limits are recorded in [the operational guide](../windows-android.md)
and [NOTES.md](../../NOTES.md).
