# Release, integrity and updates (REL-01..07)

This document records what the R1 packaging pipeline must do and which parts
are implemented in the repository today. Anything listed under "not yet" is a
release gate, not a hidden feature.

## Local build and install - implemented

`pnpm app` builds `ThingMaker.app` in release and installs it in `/Applications`
(`scripts/install-app.sh`; `CODE_APP_DIR` changes the destination). It:

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

## Signing order and updater (REL-03) - not yet

1. Sign the app bundle with a Developer ID identity (local builds are only
   ad-hoc signed, which is enough on the machine that built them).
2. Notarize (macOS) and verify the installed result with `codesign --verify`
   and a launch smoke test.
3. Updater: use `tauri-plugin-updater` with a pinned public key committed in
   `tauri.conf.json` and the private key held only in release infrastructure.
   Updater signature verification is separate from OS code signing. Rotate
   keys by shipping a release that trusts both the old and new key before
   removing the old one.

The updater plugin is not enabled in this repository: no key pair exists yet,
and enabling it with a placeholder key would be a nonfunctional promise.

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

For each provider upgrade (claude-agent-acp, or Codex's app-server):

1. Compare the advertised capabilities, config options and model catalog, the
   update and notification shapes, and the approval requests.
2. Run `cargo test --workspace` with the gated live tests (`THINGMAKER_REAL_CLAUDE=1`,
   `THINGMAKER_REAL_CODEX=1`, `THINGMAKER_REAL_DELEGATION=1`).
3. Update the mocks in `packages/test-fixtures/acp/` to the new shape.

Unsupported changes must surface as compatibility errors.
