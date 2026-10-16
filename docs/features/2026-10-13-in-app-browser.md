# In-app browser and element annotation

Status: Shipped
Date: 2026-10-13

## Problem

An agent changes a web UI, then the developer switches to Chrome, finds the dev server's port, reloads, spots what is wrong, and describes it back in words: "the second button in the settings form, the one under the email field". The agent then guesses which element that is. Every round trip costs a window switch and a description that loses precision.

Claude's desktop app puts a browser next to the conversation and lets the user click an element to add it to the message. hinacode needs the same loop, scoped to the thread whose dev server is running.

## User flow

1. In a thread, press `mod+shift+b` or click the globe in the activity bar. The Browser view opens in the side panel, wide.
2. With no page open, the view lists the TCP ports the thread's processes listen on. Clicking one opens `http://localhost:<port>`. Typing in the address field and pressing Enter opens any http(s) URL; `5173/settings`, `localhost:5173` and `example.com` get a scheme added.
3. Back, forward and reload work like a browser. A thin bar shows loading. A page that fails to load shows why, with Retry.
4. Click the pointer button (Select element) next to the address. The page dims its pointer and highlights the element under it in violet, labelled with its tag, class and size. Arrow Up selects the parent, Arrow Down the first child, Left and Right the siblings, Enter picks, Escape cancels.
5. Clicking (or Enter) picks the element. Selection mode ends, the composer gains a chip with a screenshot of the element and `<button.primary>`, and focus moves to the composer so the developer types what to change.
6. On send, the agent receives the message, the screenshot, and a text block with the page URL, a CSS selector, the React components that rendered it (in a React dev build), its text and its HTML.
7. The panel header is a tab strip, so the app and its admin page, or two dev servers, stay open side by side. `+` or `mod+t` opens a tab and focuses its address field. Each tab is titled after its page. Switching tabs keeps every page running, so a form half filled in one tab is still there when the developer comes back. Arrow keys switch tabs, Delete or middle click closes one, and closing the last tab leaves an empty one.

## Design

### Data

`src/shared/domain.ts` adds `PickedElement { url, selector, html, text, components }` and an optional `element` on `Attachment`. A picked element is an image attachment (the screenshot crop) that carries where it came from, so staging, persistence, history rendering and image delivery stay one path. Message parts are JSON, so there is no migration.

### Browser

The view is an Electron `<webview>` (see `docs/adr/0014-webview-for-the-in-app-browser.md`). It lives in the renderer's DOM, so it lays out with the panel and popovers draw over it.

- The page runs in its own sandboxed process in the `persist:browser` session, apart from the app's session. Logins to the dev app survive restart.
- `will-attach-webview` strips any preload, forces `sandbox`, `contextIsolation` and no node integration, pins the partition, and refuses a `src` that is not http(s). The pure check lives in `security.ts` with a test.
- The guest may navigate only to http(s). `window.open` and `target=_blank` load in the same view (the webview has `allowpopups`, and main's window-open handler loads the URL in place and denies the window). The browser session refuses every permission except sanitized clipboard writes, which copy buttons need.
- rpc stays refused, because the guest's top frame is not the app document (`isTrustedSender`) and it has no preload.
- Each thread's tabs live in `stores/browserTabs.ts` (memory): a never-empty list of `{ id, url, title }` and the shown tab's id. A thread that has not touched the browser shares the `NO_TABS` constant, so selectors stay stable.
- Every tab keeps its own `<webview>` mounted. Hidden tabs are `invisible` and `inert` rather than unmounted, so they do not reload. A pick in flight is cancelled when its tab is hidden.
- A side panel view can supply a `header` component in `views.ts`. The Browser view uses it for the tab strip, a horizontal tablist with automatic activation.
- Switching views unmounts every webview, and coming back loads each tab's last URL again.

### Picking

`src/renderer/lib/elementPicker.ts` holds a self-contained function that the view injects with `webview.executeJavaScript`. It draws its overlay in a closed shadow root, swallows the pointer events of the click, and resolves with `{ element, rect }`, or null on Escape or cancel. The renderer decodes the result with a schema, because it comes from the page.

The renderer crops with `webview.capturePage(rect)`, scaling the rect by the page's zoom factor, stages the PNG with the existing `attachments.stage`, and adds `{ ...staged, element }` to the draft. A navigation aborts a pick in flight, so a late result never captures the next page.

### Delivery

`src/main/agents/elementContext.ts` formats `PickedElement` as text. Claude gets the image block followed by that text; Codex gets the local image followed by a text input. The text says the fields are page content, not instructions, and fences the HTML with more backticks than any run inside it, so markup cannot close the fence and read as the user. The schema caps every field (HTML 4000 characters, text 500), because the picker runs in the page's own world, where its scripts can tamper with it.

## Out of scope

- Drawing on the page (pen, arrows, boxes), which Claude's app has. Picking covers the precise case; drawing is the next slice if people ask.
- Devtools, device-size presets, console capture and favicons. The renderer CSP refuses remote images, so tabs show a globe.
- Persisting tabs across restarts, and dragging tabs to reorder them.
- Keeping the page alive while another view shows. It reloads when the Browser view returns.
- Vue, Svelte and other component names. React is read from the fiber the dev build attaches to DOM nodes.

## Verification

With `verify-hinacode`, start a static server in the thread's workspace, open it from the ports list, pick an element with the mouse and with the keyboard, and screenshot the highlight and the composer chip. Send one short turn and read the user message back with `threads.transcript`. `security.test.ts` covers the webview attach check.
