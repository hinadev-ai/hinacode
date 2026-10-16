# Remote mode

Status: Shipped
Date: 2026-10-12

## Problem

A developer leaves the desk with agents still running. From the sofa or the train they want to know which thread is waiting on them, approve the command it asked about, answer its question, send the next prompt, look at the pull request it opened, and run `pnpm test` in its worktree. Today none of that is possible without the desktop in front of them: every rpc method lives behind the Electron window, and the only thing reachable from the network is the automation webhook.

## User flow

1. Settings > Remote. Turn **Allow remote control** on. kkcode generates an access token, starts listening on the chosen host and port, and shows a QR code plus the pairing URL. Tailscale users keep the default `0.0.0.0` bind and see the machine's Tailscale name; LAN users see the hostname.
2. On the phone, open the kkcode app. Scan the QR code, or paste the pairing URL. The app connects, stores the connection in the secure store, and lands on the thread list.
3. The thread list is the desktop sidebar on a phone: threads grouped by project, with the status pill (running, waiting, failed, done) and the threads that need a human sorted to the top. Pull to refresh is never needed; pushes keep it live.
4. Tap a thread. The transcript streams as on the desktop. An approval shows Allow, Allow for session and Deny. A question shows its options. The composer sends a prompt, steers a running turn, or stops it.
5. The thread's **PRs** tab lists the linked pull requests with their state, checks and review decision, and offers Merge and Close.
6. The thread's **Terminal** tab opens a shell in the thread's worktree, through the same `terminal.*` methods the desktop drawer uses. Output streams from the moment the phone opens the session; there is no scrollback handoff between devices.
7. **New thread** on a project creates one with the user's defaults and opens it.
8. Settings > Remote has **Rotate token**, which disconnects every phone, and the switch turns the listener off.

## Prior art

T3 Code and Orca both solve this the same way at the core: one WebSocket per host machine, a QR code that carries the endpoint and a device token, a handshake before any method runs, and an Expo app with expo-router on the phone. They differ above that. T3 Code adds scoped sessions, a Cloudflare tunnel relay and a native libghostty terminal. Orca adds its own end to end encryption with the host's key pinned in the QR code, a hosted relay, and a WebView terminal. kkcode takes the shared core and leaves out the relay, the scopes and the extra encryption: Tailscale already gives an encrypted path between the developer's own devices, and one person holds every paired phone.

## Design

The whole desktop renderer already works through one contract: `RpcMethods` for calls and `PushEvent` for live updates, both Effect schemas in `src/shared/contract.ts`. Remote mode exposes that same contract over a WebSocket, so the phone is a second renderer rather than a second API.

### Data shape

Settings gains a section:

```ts
remote: {
  enabled: boolean // default false
  bindHost: string // default "0.0.0.0"
  port: number // default 48081
}
```

The access token is a 32 byte random value stored through `Secrets` under `remote.token`, generated the first time the listener is enabled and replaced by **Rotate token**. It never reaches the desktop renderer as a setting; `remote.pairing` returns it once with the URL for the QR code.

Wire frames, `RemoteFrame` in `src/shared/remote.ts`:

```ts
ClientFrame =
  | { type: "auth"; token: string }
  | { type: "call"; id: number; method: RpcMethod; payload: unknown }

ServerFrame =
  | { type: "ready"; version: string }
  | { type: "result"; id: number; envelope: RpcEnvelope<unknown> }
  | { type: "event"; event: PushEvent }
```

The first client frame must be `auth`. Anything else, or no auth within 5 seconds, closes the socket. After `ready`, every `call` is dispatched through the same `dispatch` the Electron `rpc` channel uses, and every `Events.publish` is sent as an `event` frame to each authenticated socket.

Pairing URL: `kkcode://connect?host=<host>&port=<port>&token=<token>`, with `host` repeated for every reachable address (see `2026-10-16-resilient-remote.md`). The token is in the URL of the QR code only. It is not in any HTTP URL: the WebSocket upgrade carries no credential, and the token travels in the first frame.

### Which methods the phone may call

`desktopOnlyMethods` in the contract lists the entries that need the desktop window: `app.ready`, `app.focus`, `dialog.*`, `shell.reveal`, `attachments.stage`, `notifications.*` and `fs.watch`. The remote server refuses them with the `DesktopOnly` error tag. Everything else is allowed, including the `terminal.*` family and `github.merge`, because the person holding the paired phone is the same person who sits at the desktop.

### Main process

- `src/main/remote/server.ts`: the listener, a `ws` WebSocketServer on a plain `node:http` server, wrapped in `acquireRelease`. Effect's own socket API is pull based and would have doubled the code for no gain here. It restarts when `settings.remote` changes and reports `listenError` the way automations do. `src/main/remote/access.ts` holds the token and the status so the settings page can read them without the listener.
- `src/main/ipc.ts` exports `dispatch(raw, window)` so both transports share one decode, handle and encode path. Remote calls pass `window: null`.
- `Events` gets a second subscriber: the remote server registers its sockets and the Electron layer keeps sending to windows. `eventsLayer` becomes one layer that fans out to both.
- New rpc methods for the desktop renderer: `remote.status` (listening address, listen error, number of connected devices) and `remote.pairing` (URL and token for the QR code), `remote.rotateToken`.

### Mobile app

`apps/mobile`, an Expo app with Expo Router, outside the pnpm workspace so Metro and electron-vite never see each other's dependencies. Metro's `watchFolders` includes `../../src/shared`, so the app imports the contract directly and decodes every frame with the same schemas the desktop uses.

- `lib/connection.ts`: one WebSocket, reconnect with backoff, `call(method, payload)` returning the decoded response, `onEvent`. Mirrors `src/renderer/lib/rpc.ts`.
- Stores: `threads`, `projects`, `messages` (folds `TranscriptPush` with `foldTranscript` from `src/shared/foldEvent.ts`, the same reducer main and the desktop use), `pullRequests`, `terminals`.
- Screens: `connect`, `index` (threads by project), `thread/[id]` with Chat, PRs and Terminal tabs. The composer shows one chip, the agent mark and model name, which opens a full-height sheet with agent, model, effort, fast mode and access; each choice writes through `threads.update`, and drafts are kept per thread in memory. Icons are the desktop's Remix set, with the paths copied into `components/icon.tsx` and drawn by `react-native-svg`.
- Terminal: xterm.js. On native it runs inside a `WebView` that receives `terminal.data` and sends keystrokes back through `postMessage`; on web it mounts directly. While the on-screen keyboard is up, a key row adds what a phone keyboard lacks: Ctrl, which applies to the next character typed, Esc, Tab and the arrows. Arrows follow the cursor key mode the program set, which the view reports. Each keystroke is sent as it is typed. Echo takes one network round trip, as over SSH; holding keys back until the previous write is acknowledged doubled that delay in a measurement over a 150 ms link, so there is no buffering.

### Trust boundary

The listener is reachable from the network when `bindHost` is not loopback. The boundary is the token: 32 random bytes, compared with `timingSafeEqual`, held by whoever scanned the QR code. Frames are decoded with `ClientFrame` before anything is dispatched, and dispatch runs the same request schema as the Electron channel. The transport is plain `ws`; over Tailscale that is encrypted end to end by WireGuard, and on a LAN it is as exposed as the automation webhook already is. TLS is out of scope for this slice and the settings copy says so.

## Out of scope

- A relay or tunnel. The phone must reach the desktop directly, which Tailscale gives for free.
- Several tokens or a device list. One token, rotated when in doubt.
- Push notifications to the phone. The app is live only while open.
- Attachments from the phone, file explorer, git graph, settings and automations. The phone is for steering, not for everything.
- TLS on the listener.

## Verification

- `src/main/ipc.integration.test.ts`, "remote mode": a real listener on a random port; a call before auth and a wrong token are closed with 4001, a good token gets `ready`, `projects.list` round trips, `threads.create` arrives back as a `thread.updated` event, `dialog.pickFolder` answers `DesktopOnly`, a void method answers with an empty envelope, rotating the token closes the socket with 4002 and the old token stops working, turning the switch off releases the port, and turning it on again listens.
- `verify-kkcode` plus the phone app's web export (`npx expo export --platform web`, served with any static server) driven by agent-browser at a 390x844 viewport: pair with the URL from Settings > Remote, create a thread from the phone and watch it appear in the desktop sidebar without a reload, send a prompt, allow the command the agent asks about, open the Terminal tab and run `pwd` in the worktree.
- On a phone over USB (`apps/mobile/README.md`, "Run on a phone over USB"): the native bundle builds under Hermes, pairing by pasted URL, the thread list, the transcript, an approval answered from the phone, and the WebView terminal with typed input. Verified on a Samsung SM-S942Q running Android 16 in Expo Go 57.
- Not covered by a machine: the QR scanner. It needs a camera pointed at the desktop.
