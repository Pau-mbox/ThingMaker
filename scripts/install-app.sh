#!/usr/bin/env bash
# Builds ThingMaker.app (release) and installs it, so it opens from Applications,
# Spotlight or the Dock like any other app.
#
#   pnpm app              build and install; a running ThingMaker picks it up when reopened
#   pnpm app --restart    quit the running ThingMaker first, then reopen it
#
# CODE_APP_DIR overrides the destination (default /Applications). The
# installed app keeps the identifier dev.thingmaker.desktop and its data
# directory; `pnpm dev` runs as "ThingMaker Dev" with its own, so the two never
# share a database or a team socket.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="${CODE_APP_DIR:-/Applications}"
DEST="$DEST_DIR/ThingMaker.app"
APP_ID="dev.thingmaker.desktop"
RESTART=0
[ "${1:-}" = "--restart" ] && RESTART=1

# Node 24 from nvm when present: the renderer build needs it, and a shell
# opened from the Dock may not have it on PATH.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # nvm reads unset variables, so it runs outside `set -u`.
  set +u
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null
  nvm use 24 >/dev/null 2>&1 || true
  set -u
fi

# A ThingMaker.app that is not this one (another product with the same name) is
# never replaced.
if [ -d "$DEST" ]; then
  existing="$(defaults read "$DEST/Contents/Info" CFBundleIdentifier 2>/dev/null || true)"
  if [ "$existing" != "$APP_ID" ]; then
    echo "$DEST belongs to '$existing', not $APP_ID; set CODE_APP_DIR to install elsewhere." >&2
    exit 1
  fi
fi

cd "$ROOT"
echo "Building ThingMaker.app ($(git rev-parse --short HEAD)$(git diff --quiet HEAD -- . ':!target' 2>/dev/null || echo ', with uncommitted changes'))…"
pnpm --filter @thingmaker/desktop exec tauri build --bundles app
BUILT="$ROOT/target/release/bundle/macos/ThingMaker.app"
[ -d "$BUILT" ] || { echo "the build did not produce $BUILT" >&2; exit 1; }

running() { pgrep -f "$DEST/Contents/MacOS/" >/dev/null 2>&1; }
# A running ThingMaker keeps the binary it started with, so the bundle on disk can
# be replaced under it: the new build is what opens next time. --restart
# quits it first and reopens it after.
WAS_RUNNING=0
running && WAS_RUNNING=1
if [ "$WAS_RUNNING" -eq 1 ] && [ "$RESTART" -eq 1 ]; then
  echo "Quitting the running ThingMaker…"
  osascript -e "tell application id \"$APP_ID\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do running || break; sleep 0.5; done
  if running; then
    echo "ThingMaker did not quit; the new build is at $BUILT. Quit it and run this again." >&2
    exit 2
  fi
fi

# Before ThingMaker it was called Code (identifier dev.claudex.desktop). That
# bundle goes to the Bin — not deleted — so Spotlight and the Dock offer only
# this one. Its data was copied over on ThingMaker's first start.
LEGACY="$DEST_DIR/Code.app"
if [ -d "$LEGACY" ] && [ "$(defaults read "$LEGACY/Contents/Info" CFBundleIdentifier 2>/dev/null || true)" = "dev.claudex.desktop" ]; then
  if pgrep -f "$LEGACY/Contents/MacOS/" >/dev/null 2>&1; then
    echo "Note: the old Code.app is still running; quit it, then run this again to retire it."
  else
    mkdir -p "$HOME/.Trash" && mv "$LEGACY" "$HOME/.Trash/Code (before ThingMaker) $(date +%s).app" && echo "Moved the old Code.app to the Bin."
  fi
fi

# Copy beside, then swap, so a failed copy never leaves a half app.
rm -rf "$DEST.new"
ditto "$BUILT" "$DEST.new"
rm -rf "$DEST"
mv "$DEST.new" "$DEST"
# One ThingMaker on the machine: the build output is removed once installed, so
# Spotlight and the Dock cannot open the copy in target/ instead. A copy that
# is running is left where it is, with a word about it.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
if pgrep -f "$BUILT/Contents/MacOS/" >/dev/null 2>&1; then
  echo "Note: ThingMaker is running from $BUILT, not $DEST. Quit it and open ThingMaker from Applications."
else
  rm -rf "$BUILT"
  [ -x "$LSREGISTER" ] && "$LSREGISTER" -u "$BUILT" >/dev/null 2>&1 || true
fi
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$DEST" >/dev/null 2>&1 || true
printf '%s %s\n' "$(git rev-parse --short HEAD)" "$(date '+%Y-%m-%d %H:%M')" > "$ROOT/target/installed-build.txt"
echo "Installed $DEST ($(cat "$ROOT/target/installed-build.txt"))."

if [ "$RESTART" -eq 1 ]; then
  open "$DEST"
elif [ "$WAS_RUNNING" -eq 1 ] && running; then
  echo "ThingMaker is still running the previous build; quit and reopen it (or run 'pnpm app --restart') to use this one."
fi
exit 0
