# 0026. The phone app reads the server through atoms

Status: Accepted
Date: 2026-11-11

## Context

The phone app talks to one or more servers over a WebSocket. `call()` returns a new promise each time, so a screen could not read it during render. Every read became an effect: start the call, guard against a stale answer with a `current` flag, put the answer in state, and list `connected` or `generation` as a dependency so the read ran again after a reconnect. The app had about 70 effects, and most were this shape.

React 19's `use()` reads a promise during render, but it needs a promise that stays the same across renders and is replaced after a reconnect or a push. That cache is the missing piece, and `use()` does not provide it. It also suspends while a read runs again, which hides what the screen already showed on a flaky link.

## Decision

Reads go through atom families from `effect/reactivity`, read with `@effect/atom-react`, as on the desktop. `rpcFamily` in `apps/mobile/src/lib/remote.ts` keys a read by its payload and server, reads again after any handshake or a matching push, and keeps the last answer while it does. `loaderFamily` does the same for the zustand stores that hold pushed state. Wiring that lasts the whole app (restoring servers, routing pushes, AppState, NetInfo, pairing links) starts once in `start-app.ts`, outside React.

The app lints with the root `.oxlintrc.json`, the same React Compiler, React Doctor and HinaCode rules as the renderer. Three `jsx-a11y` rules that assume DOM elements are off for `apps/mobile`, because React Native's `role` and `autoFocus` props are the platform API.

## Consequences

A screen reads data in one line and gets reconnect handling for free. Effects that remain synchronize with something outside React: keyboard and AppState listeners, timers, animation frames and the terminal.

Reads do not suspend. A screen branches on `AsyncResult` and shows the last answer, flagged `waiting`, while it reads again. If a screen needs a loading boundary, use `useAtomSuspense` there, not across the app.
