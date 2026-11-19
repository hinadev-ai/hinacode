# Workspace sash

Status: Building
Date: 2026-11-15

## Problem

The sidebar and the side panel each resized alone. Dragging the side panel wider stopped at half the window, and dragging past a pane's minimum did nothing. In VS Code the same drag keeps going: once the editor reaches its minimum the drag pushes the sidebar, and pulling further snaps it closed. Developers who live in VS Code expect that.

## User flow

- Drag the side panel's left edge to the left. The thread shrinks to its minimum, then the sidebar shrinks to its minimum. Pull half the sidebar's minimum further and the sidebar snaps closed, and the thread takes its space. Drag back and it reopens at its old width.
- Drag the side panel's edge to the right past its minimum, or the sidebar's edge to the left past its minimum, and that pane snaps closed the same way.
- Drag the sidebar's edge to the right. It grows to its 480px maximum, pushing the thread and then the side panel.
- With the sash focused, the arrow keys move it 16px and Home and End take the pane to its bounds. The keyboard pushes panes but never snaps them. Double-click still resets the width.

## Design

- `lib/splitView.ts` `dragSash` is a pure port of `SplitView.resize` from VS Code (`src/vs/base/browser/ui/splitview/splitview.ts`). It takes the pane sizes at the start of the drag and the total delta, and returns every pane's size and visibility. A snapping pane hides once the delta passes its side's limit by `floor(min / 2)`. VS Code measures that limit against both sides of the sash. We measure it against the pane's own side only, because the sidebar has a maximum: with both sides, dragging the sidebar past 480px would snap the side panel closed even though nothing pushed it.
- Panes mark themselves with `data-workspace-pane`: `sidebar` (the sidebar or the settings nav), `content` (the thread column, or `main` on other routes) and `side-panel`. Each declares its bounds as CSS `min-width` and `max-width`. When a drag starts, `WorkspaceSash` reads the visible panes in DOM order with their computed bounds, and drops any pane that contains another, so `main` counts only when no side panel sits inside it.
- During the drag the sash writes widths and `sidebarOpen` and `sidePanelOpen` to the ui store once per animation frame, and React renders them. Only panes that changed are written, so a default side panel width stays the default. Pointer up persists the widths through `setSidebarWidth` and `setSidePanelWidth`.
- The sash is not the drag target. A snapped pane unmounts its own sash, and iframes in the side panel swallow pointer events, so pointer down puts a transparent shield over the whole window and captures the pointer on it until pointer up. VS Code turns off pointer events on iframes for the same reason.
- The side panel has no maximum, so a drag can push the sidebar. It used to be capped at 960px, half the window, and the room the thread left, measured from `<main>` in JS. That measurement lagged a frame behind a drag that resized two panes at once. Now the thread column has a CSS `min-width` (`CONTENT_MIN_WIDTH`), and when the window narrows, flexbox shrinks the side panel down to its own `min-width`.

## Out of scope

- Dragging a closed pane open from the window edge. VS Code keeps a sash at the edge for that. Here the toggle buttons and shortcuts reopen panes.
- The terminal drawer and other vertical splits.

## Verification

- `src/renderer/lib/splitView.test.ts` covers the push, the snap threshold, the reopen and the one-sided limit.
- In the real app, open a thread with the side panel docked, drag its edge to the left across the window, and watch the sidebar shrink and then snap closed. Drag back and it returns.
