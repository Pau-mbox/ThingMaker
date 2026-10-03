# Windows port — 2026-10-02

Upstream snapshot: `7bb7f89e0b66539f1d69b3ff56dcf71f27bc90ef`.
The Windows/Android adaptation is committed locally in this checkout; it has
not been published upstream. The sections below are dated historical evidence.

## Current status — 2026-10-03

Upstream main at 4326772 is merged locally, preserving Windows and Android.
Android 2.0.1 (versionCode 3) is published in JackApps and tested in the emulator.
The new Windows NSIS installer is built but not installed: automatic execution
was rejected by policy. The PC still runs the 2026-10-02 build with API v2.
See docs/windows-android.md for the consolidated setup and verified status.

## Implementation

- Native x64 Tauri application and per-user NSIS installer. `pnpm app`
  selects the Windows PowerShell installer or the original macOS script.
- Windows build script loads the Visual Studio x64 toolchain, builds,
  silently installs, and creates the normal Start menu entry.
- Owner-only local named pipes for team MCP, rejecting remote clients and
  retaining session-token authentication. Unix sockets remain on Unix.
- Windows user-home fallback, native Codex desktop discovery, npm-global
  Claude ACP discovery, `.exe` discovery for provider programs, and Windows
  drive letters in adapter overrides (use `script;node` on Windows).
- Case-insensitive Windows environment baseline and correct PATH separators.
- ConPTY terminal using `cmd.exe /D`, including shell-exit handling that closes
  the pseudo-console so output drains and the exit event is delivered.
- Windows Credential Manager for runtime secrets (2560-byte values). The
  metadata database stores names only.
- Windows local clock for provider reset times, Windows file manager action,
  normal Windows window frame, and subprocess helpers without console windows.
- Batch-wrapper discovery for MCP probes, platform-specific command fixtures,
  CRLF-compatible skill assertions, deterministic Git test fixtures, and the
  existing stale contracts test updated to include Gemini.

## Validation

- TypeScript checking passed; 254 frontend/contracts tests passed.
- Supervisor suite passed: 252 unit tests and 38 mock integration tests.
  The two pre-existing ignored tests remain ignored. Real-provider tests are
  gated and return early in this general run; that is not live-provider proof.
- Desktop unit tests passed, including actual Windows Credential Manager
  save/read/delete of a unique temporary test item, removed after the test.
- `cargo clippy --workspace --all-targets -- -D warnings` passed.
- Separately enabled real Codex test passed against the installed Codex
  desktop binary: native app-server session, a read-only prompt answering
  `OK`, successful settlement, quota, token accounting, and a saved rollout.
- Claude ACP adapter installed. At the final UI check, both Claude and Codex
  were signed in and their usage readings were visible. A live Claude text
  turn remains unverified. Gemini is not installed/validated.
- Installed application's native Windows window was visually inspected;
  provider discovery and usage display worked, and logs confirmed the
  owner-only named-pipe listener started without startup errors.
- macOS behavior has been preserved in conditional code, but no macOS build
  or launch was performed on this Windows machine.

Detailed local logs are under the ignored `target` directory:
`windows-tests.log`, `windows-desktop-tests.log`, `windows-real-codex.log`,
`windows-clippy.log`, and `windows-build.log`.

## Installation and updates

Application on this machine: `D:\apps\ThingMaker\thingmaker-desktop.exe`.
Desktop and Start menu shortcuts point to this location. The local build
script remembers it in `target/install-directory.txt`.
Default for a new checkout: `%LOCALAPPDATA%\ThingMaker`.
Installer: `target\release\bundle\nsis\ThingMaker_0.0.0_x64-setup.exe`.
User metadata/logs: `%APPDATA%\dev.thingmaker.desktop`.

Quit ThingMaker through its tray menu before updating, then run `pnpm app`.
Review upstream changes before pulling over this local Windows port.

The last build completed but its automatic install correctly refused while
the application was open. After the user authorized closing it, that final
NSIS bundle was installed successfully in `D:\apps\ThingMaker`, and this
installation was reopened and inspected. The earlier app was not interrupted
while its sign-in was in progress.

## Android remote control — 2026-10-02

Published ThingMaker Remote 1.0.0 (versionCode 1), package `dev.thingmaker.remote`,
in JackApps: https://builds.jacksparrot.com/apps/dev.thingmaker.remote/1.0.0-1.apk.
The origin APK SHA256 matches the local tested build:
`06225f2623addd5062cf5beba7ad586d91bcce4787285f5f47ecedfecfe2a7ce`.
Published with the repository's upload-build skill and meaningful release notes.

The installed Windows NSIS bundle includes the remote API in the same Tauri
AppState and supervisor actors. It listens on loopback 18420; finite command
allowlist, bounded request body, strict UUID for message submissions, exact
Bearer authentication with constant-time hash comparison. Key file under the
user's `.thingmaker` directory, restricted to the current Windows account.
Settings shows/copies the local key and can generate another to revoke it.
No key is embedded in the APK. Android stores it using AES-GCM with Android
Keystore and disables backup and cleartext HTTP.

Public origin https://thingmaker.jacksparrot.com uses the existing managed
Cloudflare tunnel on SERVER. The scheduled task `ThingMakerRemoteForward`
executes SSH directly (not Windows PowerShell 5, whose startup hung here),
with a loopback reverse forward, login trigger, keepalive and automatic restart
on failure. No router forwarding or LAN API listener. Existing tunnel routes
were preserved; pre-change configuration saved on SERVER. PC and ThingMaker
must be running. Mobile resumes a live attachment rather than starting a second
agent; reconnect/network replay retains event sequence, with an explicit warning
if the actor's bounded retained history has dropped older events.

Validation: frontend/contracts 254 tests passed; desktop clippy with warnings
denied; remote exact-key/revocation unit test; real HTTPS smoke checks rejected
missing/incorrect/revoked keys, unsafe request ids, unknown routes, and duplicate
submission, and verified a real Codex reply, same desktop actor, history replay
and cancellation. Receipt: `target/remote-verification.json`.
Android API35 emulator installed the APK, authenticated with the entered key,
restored the encrypted saved connection, listed the shared workspace/session,
attached to the existing live actor, and sent a message that received
`ANDROID_REMOTE_OK` from real Codex. The emulator originally had airplane mode
enabled; enabling its test network resolved DNS. Final desktop installer exited
0 and HTTPS health remained OK after restart. Final Android build changes only
status translations from the tested live build. The published final APK was
reinstalled in the emulator, restored its saved connection, and resumed the
durable conversation after the final desktop restart, replaying both real
responses with the translated status. A physical-phone run and a real
remote Claude turn remain untested. Attachments, terminal control, file review,
and adding project folders remain desktop features in this version.

### 502 recovery — 2026-10-02

The desktop origin was healthy but `ThingMakerRemoteForward` had stopped with
exit status 0, which the original failure-only restart policy did not recover.
Restored the link and changed the scheduled task to a PowerShell 7 worker that
reconnects after every SSH exit, including clean exits. A one-minute repeating
trigger also restarts the worker if it is stopped; overlapping runs are ignored.
The task retains its login trigger. Windows PowerShell 5 is not used.
Verified a forced disconnect of the supervised SSH child: a new SSH child was
created automatically and public HTTPS health returned 200 again. The API key,
Android APK and existing conversations are unchanged.

### Shared desktop UI on Android / WebSocket v2 — 2026-10-02

Replaced the simplified Compose conversation screens with the desktop React
renderer bundled in the Android APK. Compose retains HTTPS/API-key onboarding;
Android Keystore retains the existing encrypted credential. WebViewAssetLoader
serves a dedicated local HTTPS origin. Only its main frame can reach the native
message bridge; native OkHttp owns the authenticated WSS connection and the API
key is absent from APK bytes and JavaScript storage/URLs. Shared renderer source
is compiled for safari13 in the standalone Android packaging build and chrome105
inside the Windows Tauri build, so their output hashes differ by target.

The server explicitly dispatches 163 existing typed commands against the SAME
AppState/actors. Session channels, terminal output, job/Big Thing notifications
and metadata updates are pushed through /v2/ws. Authentication is checked on
upgrade, every request and the heartbeat; key rotation revokes live sockets.
Bounded output and concurrency avoid unbounded stream queues. Disconnects abort
subscriptions, preserve accepted work, and never automatically repeat uncertain
writes. Reconnects restore channels and reconcile snapshots/history; a PC restart
returns stale sessions to the workspace for explicit resume. Terminal scrollback
replaces the previous display on reconnect. REST v1 remains supported.

Added Android sidebar drawer, touch controls, scrollable tabs and native
confirmations/media upload/text export. Fixed WebView initial zero-height viewport
with resize-driven pixel height (also follows the software keyboard). Provider
sign-in and external PC editors remain PC actions; PC-native skill/multi-artifact
export dialogs are not forwarded. API-key generation remains desktop-only.
Fixed CMD starting in C:\Windows when Rust's verbatim local canonical path was
mistaken for UNC: terminal creation now passes the normal project drive path;
network folders are rejected explicitly rather than silently changing directory.

Validation: 256 frontend/contracts tests (254 desktop including 2 duplex-recovery
regressions, 2 contracts), 4 desktop Rust tests including CMD cwd regression,
clippy with warnings denied, successful Android and NSIS builds. Final installed
server passed real public-WSS authentication rejection, forbidden key command,
invalid/duplicate submission rejection, pushed real Codex response, bidirectional
terminal including correct project cwd, reconnect replay and global metadata
push. Receipt: target/websocket-verification.json.

Final APK API35 emulator sent FINAL_ANDROID_UI_OK from the shared composer and
received the real PC response. A network outage showed reconnecting, then restored
the same conversation without duplicate responses or an error banner. Final
installed PC restart recovered to the project; Resume attached to the current
actor, and opening Terminal from Android showed D:\repos\ThingMaker-Remote-Demo.
Portrait viewport was 939 CSS pixels with no horizontal overflow. Screenshot:
target/android-shared-final.png. Physical phone and remote Claude turn untested.

Published ThingMaker Remote 2.0.0 (versionCode 2) through JackApps HTTPS admin API;
catalog confirmed it was latest at that publication. Local and SERVER APK SHA256 agree:
7E49682773B0D1D7E94F83271B0F7CB9CCAFC150B62E974172D00B5B4AFC4D33.
URL: https://builds.jacksparrot.com/apps/dev.thingmaker.remote/2.0.0-2.apk
PC final NSIS installer exited 0; public /health reports API 2. Existing key and
encrypted saved Android connection were preserved. Removed the extra background
app instance created by installer/manual launch; the live origin and renderer now
belong to one installed process.

## 2026-10-03: merge upstream main activity groups

Fetched origin/main at 4326772. Saved all existing Windows/Android adaptations
in local checkpoint 0114be5 and backup/windows-android-before-main-20261003.
Merged in 038a0fe; the only textual conflict was the appended styles.css rules.
Kept both upstream tool groups and the Android responsive rules. Added 44px
touch targets, wrapping labels and mobile details margins. Adapted tool step
paths for Windows canonical prefixes, case differences and slash variants;
preserved Windows backslashes and recognized PowerShell/CMD read/list commands.
Remote dispatcher regeneration found the same 163 explicit operations.

Validation: 272 frontend/contracts tests, 3 Codex bridge tests, 4 desktop native
tests, clippy with warnings denied, Vite, NSIS and Android builds passed. APK
2.0.1 (versionCode 3) installed over 2.0.0 in the Android emulator, preserving
the encrypted connection. Public WSS verified authentication rejection,
duplicate submission rejection, a real Codex reply, duplex terminal, replay and
metadata events. A second real Codex turn used a shell tool; Android displayed
its collapsed and expanded group, a 44px step control and no horizontal overflow.
Receipts: target/websocket-verification.json, target/main-tool-verification.json.

The automatic policy review rejected running the new Windows installer with a
generic blocked-by-policy reason. The existing installed PC application was
restarted and remains healthy, using the previous build. Its shell events do
not yet include the new Codex commandActions metadata; the new Rust bridge is
covered by tests but not validated in the installed host. New installer:
target/release/bundle/nsis/ThingMaker_0.0.0_x64-setup.exe. Manual installation
is still required. Physical Android device testing remains outstanding.

Published Android 2.0.1 (3) through the JackApps HTTPS admin API after a dry run.
Local and SERVER APK SHA256 agree:
5D1492F074C3CAC0249DA1372C4EC63CA296CEAFD96A78A86C624380A0182297.
URL: https://builds.jacksparrot.com/apps/dev.thingmaker.remote/2.0.1-3.apk.
The installed previous PC build remained healthy at the final public API v2
health check. The extra --thingmaker-mcp process is a delegation relay, not a
second desktop instance; process count alone is not a duplicate-instance check.

Android 2.0.2 (4), from an emulator comparison against the installed PC app.
Root cause of the collapsed sidebar drawer and empty command palette: Compose
AndroidView gives the WebView WRAP_CONTENT layout params, so Chromium resolved
vh/dvh to 0 (innerHeight was correct, hence the earlier --android-viewport-height
workaround only fixed .app). MATCH_PARENT fixes every vh rule at once. With
targetSdk 36 edge-to-edge, adjustResize no longer resizes the window; the
composer stayed under the keyboard until imePadding() was added. Terminal
keystrokes were reordered remotely ("echo" arrived as "ecoh") because each
onData chunk was an independent request handled concurrently; writes are now
serialized and coalesced client-side. Verified in the emulator: drawer,
palette, Settings, Integrations, Agents, Big Thing, Files, a real Codex turn
started from Android and reflected live on the desktop, terminal in the
workspace folder with ordered input, and close confirmation ending cmd.exe.
Open: after re-attaching, the last typed terminal command reappears unexecuted
at the prompt (cause not investigated); Claude remote turn and physical phone
still untested.

Published Android 2.0.2 (4) through the JackApps HTTPS admin API after a dry run
(commit acb1a03). Local and SERVER APK SHA256 agree:
AA8BC0ED13C16E397684A6AE53917B8DD7A0550C233C501261B41577702D6959.
URL: https://builds.jacksparrot.com/apps/dev.thingmaker.remote/2.0.2-4.apk.
