# ADR-012: One phone system, two ways in

**Status:** Accepted, 20 October 2026.

## Context

Two phone systems were written for ThingMaker. One meets the computer at a
Cloudflare Worker relay the user deploys, behind Cloudflare Access, with
per-phone tokens from QR pairing, notifications, an optional lock and app
installs. The other (Francisco Pons's Remote) reaches a loopback listener
through the user's own tunnel, bundles the screens in the APK, keeps its
secrets in the Android Keystore and has a polished phone layout and steadier
reconnection. Each had what the other lacked, and two of everything —
listeners, command lists, bridges, apps — is the wrong shape.

## Decision

One phone bridge with one command list and one pairing flow, reachable two
ways, the user's choice, both off by default:

- **Relay** — the computer connects out to the user's Worker; nothing
  listens.
- **Direct** — the computer listens on `127.0.0.1` only; the user's tunnel
  (cloudflared, Tailscale Funnel, an SSH reverse forward) exposes it at an
  HTTPS address. Cloudflare Access in front is optional.

One Android app, `dev.thingmaker.remote`, with the screens bundled and
served from a local origin; native code owns the socket, the Access headers
and the phone's token, sealed with a Keystore key. The QR (version 3)
carries the mode, the address and any Access token.

The phone may read and steer sessions, Big Things and jobs, attach files and
read Files & Changes. The terminal, git writes, file writes, workspace trust,
sign-ins, settings and the runtime environment stay on the computer.

## Consequences

- The command list in `remote/dispatch.rs` is the one allowlist for both
  ways in; widening it is a deliberate change.
- The phone's screens follow the APK, not the computer: an older app can
  meet a newer computer. The protocol (`hello`, `call`, `channel`, `event`)
  stays backward compatible.
- Reliability is shared: at most 16 calls run per phone and more are
  refused unrun; a phone that falls 4096 frames behind or misses events is
  closed and reloads; the phone never resends a call whose outcome is
  unknown.
- ADR-004's "no listener" holds in the relay mode; the direct mode adds a
  loopback-only listener, on only while phone access is on in that mode.
