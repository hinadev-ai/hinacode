# Artifacts on the phone

Status: Building
Date: 2026-11-12

## Problem

The phone listed every artifact, but only documents opened. A page or a whiteboard was a row you could read the title of and nothing else, so a developer away from the desk could not see the chart or the diagram an agent made for them. The phone also could not start a document, so a plan written on the train had to wait for the desktop.

## User flow

1. A `publish_artifact` or `publish_whiteboard` card in the transcript, or a row in Artifacts, opens the artifact full screen with its title and version.
2. A page renders the way it does on the desktop, with the app theme on `:root`. Its scripts run. A tapped link to the web opens in the browser, and the page cannot navigate the screen anywhere else.
3. A whiteboard shows the whole board, fitted to the screen. Pinch to zoom. It is read-only on the phone.
4. A new version replaces the open one. A deleted artifact says so, with Retry.
5. The thread's Artifacts tab has New document. It creates an untitled document in the thread and opens the editor.

## Design

`lib/artifact-kinds.ts` maps each kind to its label, icon and screen. The transcript card and the list both open through it, so no caller compares kinds.

### Pages

A page is a directory, not one file: an entry plus relative CSS, scripts and images. The phone reaches the desktop only through rpc, so `lib/artifact-page.ts` fetches every file with `artifacts.file` and writes it to `<cache>/artifact-pages/<id>/v<version>/`. A version never changes, so a staged version is reused, and older versions of the same artifact are deleted. Files land in a staging directory that is renamed into place only when every file arrived, so a failed or interrupted download never leaves a half page that a later open would trust.

The WebView loads the entry from that directory, so relative links resolve as they do from the desktop's protocol. It gets read access to that directory only, runs `incognito`, opens no windows, and has no `onMessage`, so the page has no bridge to the app. A top-frame navigation outside the directory is refused. An http(s) one the developer tapped opens in the browser; one the page started by itself does not, so a page cannot throw the developer out of the app. Android reports no tap on a navigation, so there a page's web links do not open. A `file:` URL outside the directory is refused in every frame, and a page that crashes the viewer three times stops reloading. The theme is the desktop's `artifactThemeStyle` with the phone's palette, injected before the page's own content loads, so pages written for the desktop's tokens look native here.

ES module imports between the page's own files do not load from `file://` on iOS. Classic scripts, CSS, images and CDN scripts do. Agents rarely split a page into modules, so this was accepted rather than turning on file access from file URLs.

### Whiteboards

The desktop draws whiteboards with Excalidraw. Excalidraw ships as one prebuilt 4.4 MB file, so a WebView bundle of it would cost at least 4.7 MB in the app, against 0.5 MB for the terminal page.

`lib/whiteboard-drawing.ts` turns the scene into a static SVG instead. It reads both forms a board holds: the skeletons agents publish (`label`, `start` and `end` by id, no size) and the full elements the desktop saves after the developer draws. A skeleton arrow attaches to the facing edge of the rectangle, ellipse or diamond it names. A skeleton frame without a size wraps its children. Labels are HTML in `foreignObject`, so they wrap like Excalidraw's. In dark mode the SVG takes Excalidraw's own dark filter, so the colors match the desktop.

The page has a CSP of `default-src 'none'` and JavaScript off. Text and colors come from the agent, so text is escaped and a color must look like a color.

The strokes are clean lines, not Excalidraw's hand-drawn ones. roughjs would add that look, but it would be the phone's first new dependency for a cosmetic difference.

### New document

`artifacts.createDocument` already existed for the desktop. The thread's Artifacts tab calls it with the untitled title and opens the document editor on the result.

## Out of scope

- Editing a whiteboard on the phone.
- Creating a page or a whiteboard on the phone. Agents make those.
- Opening an artifact that no thread owns, such as one from a CLI session. The screen needs the thread to know which machine to ask.
- The page problem reporter and Export.

## Verification

- `whiteboard-drawing.test.ts`: skeleton labels, arrows attached to edges, full bound text drawn once, frames around their children, escaping.
- On the iOS simulator against an isolated desktop: publish a three-file page and a skeleton whiteboard through MCP, open both from the thread's Artifacts tab, switch to dark mode, tap the page's external link, and create a document from the tab.
