# KKCode mobile

The phone app for KKCode's remote mode: see which thread needs you, approve commands, answer questions, send or steer prompts, merge pull requests, and run a shell in a thread's worktree. It talks to the desktop over one WebSocket using the same `RpcMethods` and `PushEvent` schemas as the desktop renderer (`src/shared`). Design: `docs/features/2026-10-12-remote-mode.md`.

This is an Expo app with its own `node_modules` and lockfile. It is not part of the root pnpm workspace, so Metro and electron-vite never see each other's dependencies. Metro watches `../../src/shared` and resolves `effect` from this app, so the bundle carries one copy. The root still needs `pnpm install` for `tsc`, since it resolves `effect` types for `src/shared` from the root.

## Run

```sh
cd apps/mobile
pnpm install
npx expo start                  # scan the Expo QR code with Expo Go on the phone
npx expo start --web --host lan # or open it in a browser
```

The phone must reach the desktop directly. Tailscale on both devices is the simplest way: open the dev server through the desktop's Tailscale name, and keep the remote listener on its default `0.0.0.0` bind.

### Run on a phone over USB

With USB debugging on, `adb reverse` makes the desktop's ports reachable as `127.0.0.1` on the phone, so no network is needed:

```sh
adb reverse tcp:8081 tcp:8081      # Metro
adb reverse tcp:48081 tcp:48081    # the remote listener
npx expo start
adb shell am start -a android.intent.action.VIEW -d exp://127.0.0.1:8081
```

Pair with a URL whose host is `127.0.0.1`. Expo Go does not register the `kkcode` scheme, so paste the URL rather than opening it.

The bundle runs on Hermes, which has none of the ES2023 array methods such as `toSorted`. `tsconfig.json` pins `lib` to ES2022 so `npx tsc --noEmit` catches them; `src/hermes.d.ts` adds back the two Hermes does have.

The QR scanner (`expo-camera`) and the native terminal (`react-native-webview`) are in Expo Go. If you add a library with other native code, build a development client with `npx expo run:ios` or `npx expo run:android`.

## Pair

1. On the desktop, open Settings, Remote, and turn on Allow remote control.
2. In the app, tap Scan QR code and point it at the QR code, or paste the `kkcode://connect?host=...&port=...&token=...` URL into Pairing URL and tap Connect. Opening that URL on the phone also pairs in a development or store build, which registers the `kkcode` scheme; Expo Go does not.

The phone retains the thread while reconnecting and queues actions for up to a minute offline. Supported desktops deduplicate retried mutations and let the terminal attach to its existing shell and retained output.

The pairing is stored in the secure store (`localStorage` on web). Rotating the token on the desktop sends the app back to the pairing screen. Disconnect on the thread list forgets the pairing.

## Scripts

- `pnpm build:terminal` regenerates `src/terminal/terminal-page.ts`, the page the native terminal WebView loads, from the installed `@xterm/xterm`. Run it after upgrading xterm and commit the result.
- `pnpm build:icons` renders the app icons from the desktop's `assets/icon.svg` with `rsvg-convert`. Run it when the mark changes and commit the result.
- `npx tsc --noEmit`, `npx expo lint`, `npx expo export --platform web`.

## Out of scope

- A relay or tunnel; the phone connects to the desktop directly.
- Push notifications. The app is live only while it is open.
- Attachments, the file explorer, git graph, settings, automations and secret requests from the phone.
- TLS. Use Tailscale for an encrypted path.
