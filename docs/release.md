# Release, integrity and updates (REL-01..07)

This document records what the R1 packaging pipeline must do and which parts
are implemented in the repository today. Anything listed under "not yet" is a
release gate, not a hidden feature.

## Local build and install - implemented

`pnpm app` runs `scripts/install-app.mjs`, which picks the platform's
installer.

### Windows

`scripts/install-app.ps1` builds an x64 NSIS bundle and installs it for the
current user, in `%LOCALAPPDATA%\ThingMaker` unless `THINGMAKER_INSTALL_DIR`
names another absolute path (remembered for later builds). It refuses to
install while ThingMaker is running, so local tasks can stop safely, and
records the installed commit after a successful install.
`scripts/windows-build-env.ps1` loads the Visual Studio C++ environment.

### macOS

`scripts/install-app.sh` builds `ThingMaker.app` in release and installs it in
`/Applications` (`CODE_APP_DIR` changes the destination). It:

- refuses to replace a `ThingMaker.app` whose identifier is not
  `dev.thingmaker.desktop`;
- replaces the bundle under a running ThingMaker, which keeps the build it started
  with until it is reopened; `pnpm app --restart` quits it and reopens it;
- copies the new bundle beside the old one before swapping, so a failed copy
  never leaves half an app;
- records the installed commit in `target/installed-build.txt`.

The installed app is the everyday one. It keeps the identifier
`dev.thingmaker.desktop` and its data directory. `pnpm dev` runs as **ThingMaker Dev**
(`src-tauri/tauri.dev.conf.json`: identifier `dev.thingmaker.desktop.dev`) with a
data directory of its own. Both can run at once without sharing a database or
the team socket.

Nothing is bundled beside the app. Each provider's official program is found
where it is installed: claude-agent-acp in a global npm prefix, `codex` on
PATH or inside the ChatGPT app, or as chosen in Providers. The executable is
also the team relay, started with `--thingmaker-mcp`.

## Updates from GitHub releases (REL-03) - implemented

ThingMaker updates itself from this repository's GitHub releases.

**In the app.** About five seconds after start, then every six hours, the
app asks `https://github.com/Pau-mbox/ThingMaker/releases/latest/download/latest.json`
whether a newer version exists (`tauri-plugin-updater`, driven from Rust:
`app_update_check`, `app_update_install`). While one does, the button left of
Chill carries a blue dot; its panel shows the version and the release notes
and installs it. At startup a popup offers it too, unless Settings > Updates
turns that off. Installing downloads the bundle, verifies its signature
against the public key pinned in `tauri.conf.json` (`plugins.updater.pubkey`),
installs it and restarts; on Windows the installer runs passively and
restarts the app itself. A restart stops running sessions, and the app says
so first. The phone has nothing to update and shows none of this.

**The pipeline.** `.github/workflows/release.yml` runs on a `v*` tag. It
builds one universal macOS app (Intel and Apple silicon) and the Windows
installer with `tauri.release.conf.json` laid over the usual config, which
turns on the signed update bundles and gives the macOS app an ad-hoc
signature. It leaves a **draft** release with the installers, the update
bundles, their `.sig` files and `latest.json`. Nothing reaches anyone until
the draft is published.

Local builds (`pnpm app`) do not make update bundles and need no key.

**The key.** Update bundles are signed with a minisign key pair made by
`tauri signer generate`. The public key is committed in `tauri.conf.json`.
The private key and its password live outside the repository
(`~/.tauri/thingmaker-updater.key` and `.password` on the machine that made
them) and in two repository secrets the workflow reads:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo Pau-mbox/ThingMaker < ~/.tauri/thingmaker-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo Pau-mbox/ThingMaker < ~/.tauri/thingmaker-updater.password
```

Losing the private key means installed apps can no longer verify updates:
keep a copy somewhere safe. To rotate it, ship one release whose
`tauri.conf.json` trusts the new key, signed with the old one.

**Cutting a release.**

1. `pnpm release 0.2.0` sets the version in `tauri.conf.json`, the Cargo
   workspace and both `package.json` files, refreshes `Cargo.lock`, commits
   "Release v0.2.0" and tags `v0.2.0`. It refuses a version that is not newer
   or a tree with uncommitted changes.
2. `git push origin main && git push origin v0.2.0` starts the workflow.
3. When both builds are attached, edit the draft's notes (the app shows them)
   and publish it. Every ThingMaker from then on sees the update.

**What is still missing.** The macOS app is ad-hoc signed, not signed with an
Apple Developer ID or notarized, and the Windows installer is not
Authenticode-signed. The first install from a download therefore meets
Gatekeeper ("cannot be opened": right-click > Open, or System Settings >
Privacy & Security > Open Anyway) or SmartScreen ("More info" > "Run
anyway"). Updates installed from inside the app do not go through that
again. Developer ID signing and notarization need an Apple Developer account.

## Atomic compatibility and rollback (REL-04) - partial

- Schema migrations take a consistent SQLite backup (`thingmaker.v<N>.bak.db`)
  before applying and refuse to open a newer schema (implemented).
- Activating after local tasks stop and recording last-known-good packages
  are release-pipeline work (not yet).

## Observability (REL-05) - implemented locally

- The host writes daily-rotated logs to `<app data>/logs` with a seven-day
  retention, pruned at startup. Log lines carry level, target and message; they
  never include prompt content, credentials or full environments.
- No telemetry leaves the machine.

## Support bundles (REL-06) - implemented

Settings > Support bundle builds a JSON document with app/runtime/schema
versions, OS family, anonymized live-session state, uncertain-submission count,
recent warning/error log lines with the home directory collapsed, and
notification settings. The renderer shows the redacted preview; the user saves
it through the native dialog. Nothing is uploaded.

## Upstream upgrades (REL-07) - process

ThingMaker runs whatever provider programs are installed, so falling behind
is visible in the app: **Providers** shows each program's installed version,
the newest one where it can be asked without updating (npm, for the Claude
adapter), and an **Update** button that runs the provider's own tooling
(`npm install -g` into the prefix the adapter already lives in, or the
program's own `update`). A Codex inside the ChatGPT app updates with that
app. The check runs shortly after start and twice a day, and puts a dot on
the Providers button when an update is out. `versions::tested_with` records
the release each program was last checked against; the panel says so when an
update goes past it.

For each provider upgrade (claude-agent-acp, or Codex's app-server):

1. Compare the advertised capabilities, config options and model catalog, the
   update and notification shapes, and the approval requests.
2. Run `cargo test --workspace` with the gated live tests (`THINGMAKER_REAL_CLAUDE=1`,
   `THINGMAKER_REAL_CODEX=1`, `THINGMAKER_REAL_DELEGATION=1`).
3. Update the mocks in `packages/test-fixtures/acp/` to the new shape, and
   `versions::tested_with`.

A probe that needs no prompt (and so spends nothing): `initialize`, then
`session/new`, then compare `agentCapabilities`, `_meta` and every
`configOptions` value list between the two versions. claude-agent-acp
0.84.0 -> 0.89.1 (13 Oct 2026) renamed Fable's model id from
`claude-fable-5-1` to `fable` and added an `agent` option; the session
actor now selects a renamed model under whichever id the installed adapter
offers (`claude::launch::offered_model`).

Unsupported changes must surface as compatibility errors.
