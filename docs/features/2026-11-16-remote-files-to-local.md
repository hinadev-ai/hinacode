# Remote files to this machine

Status: Building
Date: 2026-11-16

## Problem

A project on a paired machine shows its files in the Files panel, but they stay there. To upload a screenshot the agent made on that machine, or to keep a build it produced, the developer had to copy it over by hand.

## User flow

- Drag the image in the file preview onto any app or web page. The drop receives a real file with the original name, as if it came from the file manager. This also works for local projects.
- In a project on a paired machine, the file viewer header has Download, and so does a file's context menu in the tree. The file lands in Downloads, as `name (1).ext` when the name is taken, and a toast offers Show in folder.

## Design

- `fs.readChunk { root, path, offset }` returns up to 4 MB as base64 plus the file's size. It routes to the machine that owns the root, so remote frames stay under the 16 MB limit and a file of any size arrives in pieces.
- `src/main/projectFileCopy.ts` pulls those chunks into a local file, and deletes the partial file when a chunk fails. A local root resolves or copies the file directly.
- `shell.dragFile` and `shell.download` are desktop-only. The drag copies a remote file into `$TMPDIR/hinacode-drag/`, cleared at each drag, then calls Electron's `webContents.startDrag`. The download writes into the OS Downloads folder.

## Out of scope

- Folders, and dragging rows out of the tree, where drag moves files within the project.
- HinaCode in a browser, which downloads through the browser.
- Progress for large downloads. The button shows pending until the file is written.

## Verification

`src/main/mcp/crossMachine.integration.test.ts` drags a desktop and a cloud file and downloads a multi-chunk cloud file twice. `Files.integration.test.ts` covers `fs.readChunk`. In the real app, pair a `hinacode serve` cloud, open an image from its project, drag it into a page with a drop zone, and use Download from the header and the tree menu.
