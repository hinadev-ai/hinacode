# Sketch to thread

Status: Building (experiment)
Date: 2026-11-03

## Problem

Some instructions are faster to draw than to type: "move this box under that one", a rough flow, an arrow on a layout. Today the developer has to open a drawing app, export a PNG, and drag it into the composer. The agent only ever sees an image, so the round trip through another app buys nothing.

## User flow

1. Turn on Settings > Experimental > Sketch.
2. In a thread, open the Sketch side panel (its pencil tab, or "Show Sketch" in the command palette). The panel's expand button gives a full-width canvas.
3. Draw with Excalidraw. The canvas follows the app's light or dark theme and locale.
4. Click "Attach to message" in the panel header. The drawing lands in the composer as `sketch.png`, and the composer takes focus.
5. Type a sentence if needed and press Enter.

The drawing stays in the panel per thread until the app restarts, so it can be tweaked and attached again.

## Design

- `experimental.sketch` in `ExperimentalSettings` gates the side panel view and its command, the same way `tinyVm` and `devices` do. It decodes to `false` for settings files written before it existed.
- `stores/sketches.ts` holds `{ elements, files }` per thread in memory. The view saves on every Excalidraw change and seeds `initialData` from it on mount.
- `SketchHeader` exports the stored scene with `exportToBlob` (white background, light mode, so the agent always gets dark strokes on white) and stages it through the same `attachments.stage` rpc with a `dataUrl` source that pasted images use. Nothing new crosses the IPC boundary.
- `SketchView` is `lazy()`, and the header loads `exportToBlob` with a dynamic import, so Excalidraw never enters the startup bundle.
- Excalidraw fetches its fonts from `window.EXCALIDRAW_ASSET_PATH`, falling back to esm.sh. `vite-plugin-static-copy` copies the Latin font families into `out/renderer/excalidraw/fonts`, and the view points the asset path there.

## Prototype findings

Both candidates were built and driven in the real app over CDP.

| Question                          | Observed                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dialog vs side panel              | The dialog closed on Escape, which Excalidraw also uses to finish text, and threw the drawing away. It also measured the canvas during its 0.97 scale-in animation, leaving the canvas 35px short of the right edge. The side panel had neither problem, needed no composer change, and keeps the thread visible while drawing. At the default 385px width Excalidraw switches to its compact layout; the panel's expand button fixes that. |
| Renders under the sandbox and CSP | Yes. Canvas, tools and PNG export work with the existing CSP. The only casualty was fonts: `font-src 'self' data:` and `default-src 'self'` block esm.sh, so text fell back to a serif face until the fonts were served locally.                                                                                                                                                                                                            |
| Bundle cost                       | Excalidraw adds about 2.8 MB of JS across lazy chunks (renderer output 31.5 MB to 39.7 MB including locales and 480 KB of fonts). The startup assets referenced by `index.html` grew by 9.8 KB raw (2.6 KB gzip), all of it English copy and the view, command and settings registration. No Excalidraw code is in a startup asset.                                                                                                         |

## Out of scope

- The Excalidraw scene JSON. The agents read the PNG well (Sonnet described boxes, the arrow and the handwritten note in the verification run), and the JSON costs tokens without a use yet. Add it when an agent needs to edit a drawing.
- Persisting drawings across restarts, and undo history across panel remounts.
- The CJK font family (Xiaolai, 13 MB). Chinese and Japanese text in a sketch renders in a system font.
- An entry point in the composer. The side panel tab and command palette are enough for an experiment, and the composer is being reworked elsewhere.

## Verification

With `verify-hinacode`: enable the experiment, open Sketch in a thread, draw two boxes, an arrow and a note, click "Attach to message", send. The user message shows the sketch thumbnail, `threads.transcript` lists `sketch.png`, and the agent's reply describes the drawing. Switch to Details and back; the drawing is still there.
