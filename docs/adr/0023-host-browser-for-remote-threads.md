# 0023. Host browser for remote threads

Status: Accepted
Date: 2026-10-26

## Context

The Electron webview in [ADR 0014](0014-webview-for-the-in-app-browser.md) runs on the desktop. Its localhost cannot reach a cloud thread's dev server. The cloud daemon runs in plain Node and must work on a VM without Electron or a display.

We compared T3 Code's headless host browser with Orca's local rendering through a remote network tunnel and its server-streamed browser. Forwarding application ports would fix some previews, but pages with additional loopback services, WebSockets, and remote cookies still need the host's network and browser state. Orca's Electron screencast requires a desktop process. A headless Chromium browser gives the whole page the right machine.

## Decision

Remote threads use sandboxed headless Playwright Chromium on their cloud. The desktop renders JPEG screencasts and sends a closed set of navigation and input commands through the existing authenticated, thread-routed RPC connection. Local threads keep their Electron webview.

## Consequences

- The browser and its requests run beside the agent. No extra network listener or application port forwarding is needed.
- Different threads have isolated contexts. Tabs in one thread share cookies until their context closes.
- Frames stay bounded to the newest image. A slow viewer does not build a queue of obsolete screenshots.
- The host needs Chrome, Chromium, or Playwright's Chromium installation. An ordinary page open never downloads a binary.
- A streamed canvas has no local page DOM for assistive technology. Keyboard input, a named application region, and an Escape route remain available. Full screen-reader access requires a separate design.
- Native file dialogs, audio, downloads, and persistent profiles remain outside this slice. See [the feature design](../features/2026-10-26-remote-browser.md).
