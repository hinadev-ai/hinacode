# HinaCode mobile

The phone app for HinaCode's remote mode: see which thread needs you, approve commands, answer questions, send or steer prompts, and run a shell in a thread's worktree. It also adds projects, searches threads and messages, renders replies as native Markdown text with highlighted code and workspace images, browses and searches a thread's files, shows pull request checks and reviews, gathers the pull requests that need you and your open Linear tickets in an overview, raises a banner, a local notification or a push when a thread needs you, and keeps its own settings next to the desktop's defaults. It talks to the desktop over one WebSocket using the same `RpcMethods` and `PushEvent` schemas as the desktop renderer (`src/shared`). Design: `docs/features/2026-10-12-remote-mode.md`.

This is an Expo app with its own `node_modules` and lockfile. It is not part of the root pnpm workspace, so Metro and electron-vite never see each other's dependencies. Metro watches `../../src/shared` and resolves `effect` from this app, so the bundle carries one copy. The root still needs `pnpm install` for `tsc`, since it resolves `effect` types for `src/shared` from the root.

## Run

```sh
cd apps/mobile
pnpm install
npx expo run:android            # or run:ios; builds and installs the development build, then starts Metro
npx expo start --web --host lan # or open it in a browser
```

Replies render through `react-native-enriched-markdown`, a native Fabric component, so the app needs a development build; Expo Go cannot run it. Build again after a change to native dependencies or to the `enriched-markdown` block in `package.json`, which picks the library's features (code highlighting on, math and video off). After that, `npx expo start` serves new JavaScript to the installed build.

`pnpm install` lets that library's postinstall run (`allowBuilds` in `pnpm-workspace.yaml`), because it downloads the tree-sitter grammars the native build compiles for code highlighting.

The phone must reach the desktop directly. Tailscale on both devices is the simplest way: open the dev server through the desktop's Tailscale name, and keep the remote listener on its default `0.0.0.0` bind.

### Run on an iOS simulator with Xcode 27

Xcode 27 uses [Device Hub](https://developer.apple.com/documentation/xcode/pairing-your-devices-with-your-mac) to display simulators. Open it with `open -a DeviceHub`, or choose **Xcode > Open Developer Tool > Device Hub**. Select your simulator in the sidebar. Use **Start** if it is shut down.

To choose a simulator from the terminal, list its UDID, then boot it if it is shut down:

```sh
xcrun simctl list devices available
IOS_UDID=<simulator-udid>
xcrun simctl boot "$IOS_UDID"
open "devices://device/open?id=$IOS_UDID"
```

From `apps/mobile`, build and install the native app with `pnpm exec expo run:ios --device "$IOS_UDID"`. After the first build, `pnpm exec expo start --localhost` serves JavaScript to the installed app. [Expo also documents the Device Hub workflow](https://docs.expo.dev/workflow/ios-simulator/).

To connect to an isolated local server, run this in another terminal from the repository root:

```sh
pnpm build:server
HINACODE_USER_DATA=/tmp/kk-ios-local node out/server/daemon.js serve --host 127.0.0.1 --port 48082
```

Paste the server's pairing URL into the app. The simulator can reach the Mac at `127.0.0.1`. Keep both the server and Metro running while you check the app.

To capture the simulator with Xcode 27, save to `/tmp` first, then copy into `.context/` from the repository root. This also works when the simulator cannot write directly to the checkout's volume:

```sh
xcrun devicectl device capture screenshot --device "$IOS_UDID" --destination "/tmp/hinacode-$IOS_UDID.png"
mkdir -p .context/shots
cp "/tmp/hinacode-$IOS_UDID.png" .context/shots/mobile.png
```

Check these native iOS cases after a cold launch:

- On Home, the filter tabs and first row appear below the large title. Check populated, loading, empty, and failed connections.
- Search results stay below the navigation bar, with the keyboard both open and dismissed.
- Before pairing, the form starts below the large title and its Connect button remains reachable with the keyboard open.
- Workspace, thread settings, and thread actions use readable theme surfaces in light and dark mode. Scroll a long option list, select an option, and close the popup.

#### iPhone Duo

The iPhone Duo simulator needs Xcode 27.1 and the iOS 27.1 runtime (`xcodebuild -downloadPlatform iOS -buildVersion 27.1`), then `xcrun simctl create "iPhone Duo" com.apple.CoreSimulator.SimDeviceType.iPhone-Duo com.apple.CoreSimulator.SimRuntime.iOS-27-1`. Open and close it with the controls in Device Hub; `simctl` cannot fold it.

On the closed phone the status bar, and the header buttons with it, sit in a column on the right. Check that rows, the composer, sheets and banners stay to the left of it.

### Run on a phone over USB

With USB debugging on, `adb reverse` makes the desktop's ports reachable as `127.0.0.1` on the phone, so no network is needed:

```sh
adb reverse tcp:8081 tcp:8081      # Metro
adb reverse tcp:48081 tcp:48081    # the remote listener
npx expo run:android
```

Pair with a URL whose host is `127.0.0.1`.

### Install a standalone build on Android

To run the latest code without Metro, plug in the phone with USB debugging on and run:

```sh
pnpm install:android        # or: pnpm install:android <adb serial>
```

`scripts/install-android.sh` regenerates `android/` with `expo prebuild`, builds a Release APK, installs it as `com.hinadev.hinacode` over the previous build, and opens it. You need the Android SDK in `~/Library/Android/sdk` (or set `ANDROID_HOME`) and a JDK 17+ (Android Studio's bundled one, Homebrew's `openjdk@21`, or set `JAVA_HOME`).

The phone reaches the desktop over plain `ws://`, which Android blocks in Release builds unless the manifest opts in. `expo-build-properties` in `app.json` sets `usesCleartextTraffic`, and the script refuses to install an APK without it, since that app would install fine and then stay on Reconnecting. The APK is signed with the debug key. If `adb install` reports a signature mismatch, uninstall the old app first, which also removes its pairing.

The bundle runs on Hermes, which has none of the ES2023 array methods such as `toSorted`. `tsconfig.json` pins `lib` to ES2022 so `npx tsc --noEmit` catches them; `src/hermes.d.ts` adds back the two Hermes does have.

## Pair

1. On the desktop, open Settings, Remote, and turn on Allow remote control.
2. In the app, tap Scan QR code and point it at the QR code, or paste the `https://relay.hinacode.app/connect#host=...&port=...&token=...` URL (it repeats `host` for each address the app may try) into Pairing URL and tap Connect. The older `hinacode://connect?...` form still works.

## Universal links

`https://relay.hinacode.app/connect#...` and `https://relay.hinacode.app/t/<environmentId>/<threadId>` open the app: a connect link fills in the pairing form, which still waits for a tap on Connect, and a thread link opens that thread on a phone paired with its machine. Notification taps go through the same route (`src/lib/links.ts`, called from `src/app/+native-intent.tsx`). The system camera opens the app from the desktop's QR code only once the relay serves the association files, which need the values in the config table of `docs/features/2026-10-28-universal-links.md`. A debug-signed APK fails Android's verification; approve the domain by hand with `adb shell pm set-app-links-user-selection --user cur --package com.hinadev.hinacode true relay.hinacode.app`.

The phone retains the thread while reconnecting and queues actions for up to a minute offline. Supported desktops deduplicate retried mutations and let the terminal attach to its existing shell and retained output.

Pair with every machine you use, desktop or `hinacode serve`: Settings, Servers, Add server takes another URL. A desktop does not pass its clouds on to the phone. The thread list merges every server's projects and threads and names the server of each once two are paired; Add project asks which server to use. Tap a server in Settings to reconnect it, pair it again or forget it.

The servers are stored in the secure store (`localStorage` on web) under `hinacode.servers`; a pairing saved by an older app under `hinacode.connection` becomes the first server. Pasting a new URL for a server already listed, after its token was rotated, updates that server. Forgetting the last server goes back to the pairing screen.

## Push notifications

A phone signed in to the relay registers for push, so a thread that finishes or needs you reaches it while the app is suspended or killed. Design: `docs/features/2026-10-28-push-notifications.md`. Until these one-time steps are done the phone gets no push token, registers nothing and keeps its local notifications:

1. `npx eas-cli@latest init` links the app to an EAS project and writes `expo.extra.eas.projectId` into `app.json`.
2. Android: create a Firebase project, add an Android app with the `expo.android.package` name, download its `google-services.json` next to `app.json`, and point `expo.android.googleServicesFile` at it. Then upload an FCM V1 service account key to the EAS project (`npx eas-cli@latest credentials`, Android, Google Service Account, FCM V1).
3. iOS: `npx eas-cli@latest credentials`, iOS, Push Notifications, to create or upload an APNs key.

Rebuild the development build after each step. Expo Go cannot receive these pushes.

## Scripts

- `pnpm build:terminal` regenerates `src/terminal/terminal-page.ts`, the page the native terminal WebView loads, from the installed `@xterm/xterm`. Run it after upgrading xterm and commit the result.
- `pnpm build:icons` renders the app icons from the desktop's `assets/icon.svg` with `rsvg-convert`. Run it when the mark changes and commit the result.
- `npx tsc --noEmit`, `npx expo lint`, `npx expo export --platform web`.

## Out of scope

- A relay or tunnel; the phone connects to the desktop directly.
- `gpu-lexer` in the native app. Hermes has no WebGPU, so the native file viewer uses the small lexer in `src/lib/lexer.ts`; the web build's file viewer uses `gpu-lexer` when the browser offers WebGPU in a secure context. Code blocks in replies are highlighted by the Markdown library's tree-sitter grammars on iOS and Android, and not at all on the web.
- Attachments, editing files, the git graph, automations and secret requests from the phone.
- TLS. Use Tailscale for an encrypted path.
