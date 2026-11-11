# Image editor for attachments

Status: Building
Date: 2026-11-11

## Problem

Images reach the composer six ways: paste, drop, the file picker, a browser element pick, a device element pick, and the agent's own screenshots. All of them go to the agent exactly as captured. To point at something, the developer types "the button on the right, below the header" and hopes the agent finds it. To hide a token in a screenshot, they leave HinaCode, edit the file in another tool, and attach it again.

The device and Tiny VM "Save screenshot" buttons stage an image and then only reveal it in the file manager, so it never reaches the composer. The browser has no viewport screenshot at all.

## User flow

1. An image lands in the composer by any route. It attaches straight away, as today.
2. The developer hovers the chip and presses Edit, or focuses it and presses `E`. The editor fills the window over a dark scrim, with the image fitted in the middle and a toolbar under it.
3. They press a letter to pick a tool and draw. `A` arrow, `R` rectangle, `E` ellipse, `F` pen, `T` text, `C` numbered marker, `D` redact, `V` select. `1` to `8` pick a color. In select mode they drag a shape to move it, drag its handles to resize it, and drag the handles on the image edge to crop.
4. `Ctrl+Z` and `Ctrl+Shift+Z` undo and redo. `Delete` removes the selected shape. Right-click returns to select.
5. `Enter` or Done flattens the edit and replaces the chip with the edited image. `Esc` or Cancel leaves the attachment as it was.
6. Pressing Edit again on the edited chip reopens the same layers, so nothing is baked in until the developer is done with it.

## Design

### Data shape

The editor's state is an ordered command log with a cursor, the same model Omasnap uses. What is on screen is a replay of the log up to the cursor, so undo is exact and reopening restores every layer.

```ts
type Shape =
  | { id; kind: "arrow"; from: Point; to: Point; color }
  | { id; kind: "rect" | "ellipse"; rect: Rect; color }
  | { id; kind: "pen"; points: ReadonlyArray<Point>; color }
  | { id; kind: "text"; at: Point; text: string; color }
  | { id; kind: "marker"; at: Point; color }
  | { id; kind: "redact"; rect: Rect }

type Command =
  | { type: "add"; shape: Shape }
  | { type: "update"; shape: Shape }
  | { type: "remove"; id: string }
  | { type: "crop"; rect: Rect | null }

type EditLog = { commands: ReadonlyArray<Command>; cursor: number }
```

Every coordinate is in source image pixels, so the log does not depend on the window size. A marker's number is its position among the markers, so deleting one renumbers the rest instead of leaving a gap.

### One render path

`drawDocument(ctx, source, document)` draws the image, the redactions, then the shapes. The screen canvas calls it with a fit transform and the export calls it at full resolution, so the preview and the result cannot drift.

Redaction paints an opaque block over whole pixels, so the export keeps nothing of what was under it. A mosaic was tried first, but on a screenshot most blocks take the background color and the region reads as empty space, which tells neither the developer nor the agent that something was hidden.

### Rendering cost

Plain Canvas 2D. In Electron 44 a full 4K redraw with 200 shapes, a pixelated region and a blur held 60 fps on the GPU, and the editor's canvas is never larger than the window. WebGPU would add a second rendering path and lose `pnpm test:e2e` coverage, since CI's Xvfb has no WebGPU. The editor redraws the whole canvas on each change and needs no dirty rects.

### Export

The export renders the cropped document at native resolution and encodes a PNG. If it is over `AGENT_IMAGE_MAX_BYTES`, it scales down and encodes again until it fits, because Claude refuses an image over 5 MB. It stages the result through `attachments.stage` with a data URL and replaces the original chip in place with `useDrafts.replaceAttachment`. The source and the log stay in a renderer store keyed by the new attachment's id, for reopening. They are not persisted. After a reload, Edit starts from the flattened image.

The source loads through `attachments.read` with the thread's environment, so the canvas is never tainted and cloud threads work.

### Files

- `src/renderer/lib/imageEdit/`: the log, geometry and hit testing, `drawDocument`, export. Pure, with unit tests.
- `src/renderer/components/imageEditor/`: the dialog, canvas gestures and toolbar.
- `src/renderer/stores/imageEdits.ts`: logs for reopening, and the open request other entry points use.

## Later slices

- **Entry points.** Browser viewport screenshot, device and Tiny VM screenshots into the composer, and file explorer drags into the composer.
- **Marker notes for the agent.** A marker takes an optional note. The notes ride on the attachment and `attachmentContext` turns them into text, the way picked elements already reach every provider.

## Out of scope

- Desktop-wide capture outside HinaCode. Omasnap and the OS tools already do it, and their output pastes into the composer.
- Zoom and pan inside the editor. The image is fitted to the window.
- Editing images in sent messages. Edit acts on drafts.

## Verification

- Unit tests for the log, geometry, the export size cap and that redaction leaves no source pixels.
- A component test that draws a shape, undoes it and exports.
- With `verify-hinacode`: paste a screenshot, edit it with each tool, press Done, and check the chip shows the edited image and the agent receives it.
