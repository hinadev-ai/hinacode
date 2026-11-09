# Our own whiteboard canvas

Status: Shipped
Date: 2026-11-08

## Problem

The whiteboard in the Artifacts panel drew through a third-party library. That cost a lazy chunk of about 1.1 MB, 145 KB of CSS and a font directory of hundreds of files that the renderer fetched on every open. Matching the app's theme meant overriding its CSS variables, hiding its tools meant hiding its DOM, and the fonts it wanted were not the fonts the app ships. The board only needs boxes, text and arrows that follow boxes. Everything else the library carried was weight we paid for on every install and every open.

## User flow

1. The agent calls `publish_whiteboard` with shapes, text and arrows. The Artifacts panel opens the board on our canvas.
2. The developer draws: pick a tool from the floating toolbar, drag to place a rectangle, ellipse, diamond, arrow or text, then select, move, resize, marquee-select and delete. The wheel zooms about the pointer, space or the middle button pans, and Fit recenters the content.
3. A double click edits a shape's label or a free text. Enter commits, Escape cancels.
4. Edits save on their own, like a document. The footer shows Saved, Saving or a failure with Retry.
5. The developer selects what they drew and presses Ask. The question, the selected element ids and a PNG of the selection go to the thread.
6. The Comments button lists the questions and answers. Show on whiteboard selects the elements a comment is about and centers them.

## Design

### SVG in React, not a single canvas element

The board is a `<div role="application">` holding one `<svg>`. Each element is a `<g data-element-id>` with a `transform` from a single view transform (`translate` and `scale`).

- Hit testing is the DOM: a `pointerdown` runs a geometric test only to decide what is under the pointer, and React keys each element so a drag re-renders only what moved. A single `<canvas>` would need our own render loop, device-pixel-ratio handling, manual text layout and manual hit testing for every shape, with no benefit at tens of elements.
- Colors come from the theme. Shapes, arrows and text take `fill` and `stroke` from `var(--foreground)`, `var(--muted)`, `var(--muted-foreground)` and `var(--primary)` as inline SVG styles, so they follow theme and contrast changes with no palette picker and no library overrides.
- Export for Ask serializes the same elements to an SVG string with concrete theme colors, then rasterizes it through an `Image` and a canvas. This is the one place the DOM renderer is not reused, because a serialized SVG cannot read the page's CSS variables.

### Clean lines, not a hand-drawn feel

Shapes draw with a 2px stroke and rounded corners. A rough, wobbly line would need per-element jitter, a seeded random per redraw to stay stable, and a second measurement pass for hit testing; it also fights the app's chiseled, high-contrast look. The agent's diagrams read better clean, so we keep clean.

### Text measurement and editing

Shape labels and free text wrap by a character budget derived from the box width and font size (`charactersPerLine`), then render as centered `<text>` lines. This is approximate but needs no DOM measurement during render. Editing is a `<textarea>` positioned over the element at `toScreen(view, bounds)`, so it tracks pan and zoom. The label lives on the shape as `label: { text }`, not as a separate child element.

### Hit testing

Shapes test the pointer against their outline (rectangle bounds, ellipse equation, diamond as `|dx|/w + |dy|/h <= 1`). Arrows test the distance to the segment. A marquee tests axis-aligned intersection with each element's bounds. Arrows bound to shapes resolve their endpoints from the shapes' bounds at render time, so they follow a shape the moment it moves.

### The stored format

The entry stays `scene.excalidraw` and keeps the Excalidraw file envelope, because `packages/artifacts` already reads and writes it and the `publish_whiteboard` tool description already tells agents to write that skeleton form. We did not invent a new format; the cost of a second format (migration, a second describe path, an agent that writes the wrong one) is larger than the cost of a compatible one.

What changed is only the element shape the renderer writes back. The renderer completes a skeleton into a small, explicit element: `id`, `type`, `version`, `x`, `y`, `width`, `height`, optional `label: { text }`, optional `text`, optional `start`/`end` bindings, and passthrough style fields. Every field `describeScene` reads (`type`, `text`, `label.text`, `x`, `y`, `width`, `height`, `start.id`/`end.id`, `containerId`) is present, so the agent summary and the merge keep working unchanged.

Existing `scene.excalidraw` files load through `normalizeScene`: it completes skeletons, reads either `start`/`end` or `startBinding`/`endBinding`, and folds a bound text child (`containerId`) into its container's `label`, which is how the previous library stored a label. The agent's next `publish_whiteboard` for an id replaces it whole, and `mergeScene` in the renderer lifts the replacement above the developer's version.

### The merge

`src/renderer/components/whiteboard/whiteboardScene.ts` was already library-free: `planRemote`, `mergeRemote` and `savedSnapshot` plan by element id and version. The renderer reuses it, and adds `own/scene.ts` (complete skeletons, reconcile by version, fold labels) and `own/sync.ts` (debounced save, conflict merge, catch-up on a push, save on close). A developer's unsaved move keeps its position over an identical remote version, because reconcile only takes a remote element whose version is strictly higher.

## Out of scope

- A hand-drawn or freehand pen. No ink, no pressure.
- Rotation, grouping and frames beyond what the agent's `children` field already carries.
- A palette picker, images, libraries and laser pointers.
- Editing an arrow's individual endpoints by hand.
- Live cursors and simultaneous editing. The board merges per element.

## Verification

- `own/elements.test.ts` and `own/scene.test.ts` cover geometry, hit testing, the marquee, transforms, view math, text wrapping and the merge.
- `WhiteboardView.component.test.tsx` drives the real panel in headless Chromium: load a skeleton scene without saving, move and save, save on close, merge an agent write that beat the save, add an agent patch beside an unsaved edit, ask about a selection with an image, show a comment's elements, and draw the first shape on an empty board.
- The real app with `verify-hinacode` and `HINACODE_MOCK_CLAUDE=whiteboard`.
