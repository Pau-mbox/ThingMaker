#!/usr/bin/env bash
# Builds the ThingMaker Android app and, when a phone is plugged in with USB
# debugging on, installs it.
#
#   pnpm phone            build apps/android → ThingMaker-phone.apk, install if a device is attached
#
# The app is a thin shell: its screens come from the Mac it pairs with, so
# updating ThingMaker on the Mac updates the phone's screens too. Rebuild the
# APK only when the Android side changes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$SDK/platform-tools/adb"

# Gradle 8.11 runs on Java 17; a newer default JDK is skipped.
if [ -z "${JAVA_HOME:-}" ] || ! "$JAVA_HOME/bin/java" -version 2>&1 | grep -q '"17'; then
  JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null || true)"
  export JAVA_HOME
fi
[ -n "$JAVA_HOME" ] || { echo "Java 17 is needed to build the Android app (brew install --cask temurin@17)." >&2; exit 1; }
[ -d "$SDK" ] || { echo "No Android SDK at $SDK (install Android Studio, or set ANDROID_HOME)." >&2; exit 1; }

cd "$ROOT/apps/android"
[ -f local.properties ] || echo "sdk.dir=$SDK" > local.properties
./gradlew assembleRelease -q --console=plain
cp app/build/outputs/apk/release/app-release.apk "$ROOT/ThingMaker-phone.apk"
echo "Built $ROOT/ThingMaker-phone.apk"

if [ -x "$ADB" ] && "$ADB" get-state >/dev/null 2>&1; then
  "$ADB" install -r "$ROOT/ThingMaker-phone.apk"
  echo "Installed on $("$ADB" shell getprop ro.product.model | tr -d '\r')."
else
  echo "No phone attached. Copy ThingMaker-phone.apk to the phone and open it, or plug it in with USB debugging on and run pnpm phone again."
fi
