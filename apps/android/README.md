# ThingMaker Remote

Android 8+ remote controller. Agents run in the Windows desktop, sharing its
projects, durable conversations and live actors. HTTPS only. Enter the API key
shown in desktop Settings → Control remoto Android. The key is generated on the
PC, can be rotated there, and is encrypted with Android Keystore on the phone.
No credentials are embedded in the APK; Android backup is disabled.

Build the shared desktop renderer first, then package it with Java 17 / SDK 36:

    pnpm.cmd --filter @thingmaker/desktop run build:vite
    C:\Users\franc\.local\bin\python3.12.exe scripts/shared-ui-android.py
    cd apps/android
    .\gradlew.bat assembleDebug

Package: `dev.thingmaker.remote`, version **2.0.1 (3)**. Internal distribution via
JackApps; subsequent builds must preserve the signing key and bump versionCode.
Published APK: [2.0.1-3.apk](https://builds.jacksparrot.com/apps/dev.thingmaker.remote/2.0.1-3.apk).
Full setup, operations, release history and deployment status:
[Windows and Android guide](../../docs/windows-android.md).

Server: `https://thingmaker.jacksparrot.com`, loopback origin 18420 inside the
desktop. `ThingMakerRemoteForward` runs an authenticated SSH reverse forward to
the existing Cloudflare tunnel host. Keep ThingMaker and the PC running. Projects
can be added on the PC or by entering a PC folder path in Android. The APK ships
the same React components as desktop: projects, conversations, provider/model
selection, tool cards, approvals, review, files, terminal, teams, Big Thing and
integrations. Small screens use a sidebar drawer and scrollable tabs.
Version 2.0.1 integrates upstream `4326772`: expandable activity groups,
progress labels and step counts, adapted to Windows paths and 44px mobile
touch targets. The new Codex `commandActions` metadata requires installing
the corresponding new PC build; the APK also works with the installed older
server, using its existing tool data.

Native OkHttp connects to authenticated `wss://thingmaker.jacksparrot.com/v2/ws`;
the key is an Authorization header, never JS storage or a URL parameter. Typed
commands share the desktop's existing actors. Ordered events, terminal output
and task notifications are pushed; snapshots/history reconcile reconnects. A
lost connection rejects uncertain operations without repeating submissions.
The PC continues executing while Android is closed or offline.

The bundled page is served locally by WebViewAssetLoader over its dedicated
HTTPS origin. The message bridge accepts only that origin and the main frame.
Android handles confirmations, media selection/upload and text exports. Phone
disconnect never quits the PC. Provider sign-in and external PC editors still
require the desktop; native folder/skill/export dialogs are not forwarded to
the phone. Runtime variables and cleanup use the existing desktop previews and
confirmations; their execution stays in the PC.

REST v1 remains compatible with the first APK. `/health` now reports API 2.
Validation: `scripts/verify-websocket.py` against the real public tunnel, plus
Android emulator UI testing. `scripts/android-ui-probe.py` is a debug-only helper
used through an authorized ADB-forwarded WebView debugger (never a public port).
The 2.0.1 emulator run verified saved login, a real Codex shell action displayed
as a collapsed/expanded group, 44px step controls and no horizontal overflow.
Physical phone testing and a real remote Claude turn remain pending. The latest
Windows installer was built but automatic installation was blocked; see the
guide before treating the new desktop build as deployed.
