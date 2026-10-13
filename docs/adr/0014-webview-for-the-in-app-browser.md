# 0014. A `<webview>` for the in-app browser

Status: Accepted
Date: 2026-10-13

## Context

The Browser view shows any http(s) page next to the thread and lets the user pick an element from it. Electron offers three ways to embed a page:

- An `<iframe>` in the renderer. Many sites refuse framing with `X-Frame-Options` or `frame-ancestors`, the renderer's CSP and `stayInApp` block subframe navigation, and a cross-origin frame cannot be scripted from the app, so picking would need main to reach into the frame.
- A `WebContentsView` that main stacks on the window and moves to a rectangle the renderer reports. It is what Electron recommends, but it draws above the whole renderer, so menus, tooltips and dialogs that overlap the panel go under the page. Every resize, scroll and panel animation needs a bounds message.
- A `<webview>` tag. The page runs in its own process, like a `WebContentsView`, but the element lives in the renderer's DOM. It lays out with the panel and draws in the renderer's stacking order. `executeJavaScript` and `capturePage` are on the element.

Electron 44 still ships `<webview>` behind `webviewTag: true` and documents `will-attach-webview` for locking it down.

## Decision

The Browser view is a `<webview>`. Main enables the tag and settles every webview's preferences in `will-attach-webview` (`lockDownWebview` in `security.ts`): no preload, sandboxed, context isolated, in the `persist:browser` session, http(s) only.

## Consequences

- Picking needs no new rpc. The renderer injects the picker with `executeJavaScript` and crops with `capturePage`, and the result is schema-decoded as untrusted input.
- Popovers and dialogs draw over the page with no bounds syncing.
- The guest's state lives with the element, so switching side panel views unmounts the page. Keeping it alive means keeping the element mounted.
- Electron has marked `<webview>` as discouraged for years. If a release removes it or breaks the guest under `sandbox`, the view moves to a `WebContentsView` and the overlap problem comes back.
