# Browser on the thread's machine

Status: Building
Date: 2026-10-26

## Problem

The Browser panel always runs an Electron webview on the desktop. A remote thread lists the VM's ports, but opening one reaches the desktop's localhost. Developers need to browse and interact with pages on the machine running their agent.

## User flow

Open Browser in a cloud thread and choose a port or enter an HTTP(S) address. HinaCode starts headless Chromium on that cloud. The address stays `localhost`, and page requests, cookies, scripts, and WebSockets run there. The panel shows the page and forwards mouse, wheel, keyboard, paste, navigation, and viewport changes. Select element attaches its screenshot and description to the same remote thread. Local threads keep their Electron webview.

## Design

`src/shared/browser.ts` defines the contract before implementation. `browser.open` takes a thread, URL, and viewport and returns an opaque session ID. Later calls include both the thread and session. The host checks their association, so a session cannot move between threads.

`browser.command` takes a bounded batch from a closed union of navigation, viewport, pointer, keyboard, text, selection, and release commands. Batching lets typing continue while a previous input travels to the host. It does not expose arbitrary CDP or JavaScript execution. HTTP(S) validation happens at the RPC boundary and again on page navigation. `browser.frame` returns typed page state and at most the latest JPEG newer than the caller's sequence. Selection is `idle`, `selecting`, `picked` with an attachment, or `failed` with a reason.

The cloud lazily launches Playwright Chromium. Tabs in a thread share a browser context. Different threads have separate contexts. CDP screencasts keep only the newest frame and acknowledge Chromium immediately. Frame reads use the existing authenticated RPC connection, with one request in flight per viewer. Hidden tabs pause their screencast and renew their lease without images. There is no new listener, public DevTools port, or port-forwarding configuration.

Closing a tab or panel closes its remote session. Idle leases clean up sessions after an interrupted connection. The last session closes its context, and shutdown closes the browser. Cookies live for the context's lifetime in this slice.

The host uses installed Chrome or Chromium, or Playwright's installed Chromium. `HINACODE_BROWSER_EXECUTABLE_PATH` selects a custom executable. A missing browser gives an installation instruction in the panel. No browser downloads occur during an ordinary page open.

## Prior art

[T3 Code](https://github.com/pingdotgg/t3code/blob/03df289735527354a500c8e8cf371c11d4c75d3c/apps/server/src/preview/ServerBrowserContexts.ts) runs a headless Playwright browser on the environment and streams JPEG screencasts with bounded frames. This works in a plain Node daemon on a Linux VM.

[Orca](https://github.com/stablyai/orca/blob/478ad9109c7d36f3f138f49eebc7b288475728ff/docs/site/content/docs/browser/overview.mdx) offers local rendering through the server's network and a server-streamed mode. Its current streamed implementation uses Electron web contents. HinaCode follows the host-browser design with Playwright so `hinacode serve` keeps working without Electron or a display.

## Out of scope

Mobile Browser UI, audio or video streaming, downloads, native file dialogs, DevTools, clipboard reads, persistent browser profiles, and agent browser tools are separate work. Remote contexts block service workers so the navigation filter sees every request. Offline PWA behavior is unavailable in this slice.

## Checkpoints and verification

1. Contract and routing. Schema tests reject unsafe URLs, malformed input, and oversized frames. All browser calls route by thread ownership.
2. Host browser. Real Chromium integration checks open a loopback page, receive a frame, navigate, type, scroll, resize, select an element, reject cross-thread sessions, and close resources.
3. Desktop to daemon. Pair an isolated Electron client with an isolated Node daemon. Open the daemon's page through Browser, interact through the streamed view, pick an element, switch tabs, and capture screenshots. Confirm the browser is a daemon child and the attachment lives on the daemon.
4. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the existing browser end-to-end scenarios.
