# Large diff guard in the Changes panel

Status: Shipped
Date: 2026-10-18

## Problem

A thread that bumps dependencies changes a lockfile by thousands of lines. Opening that file in the Changes panel froze the renderer: a 12.4k-line `pnpm-lock.yaml` blocked one frame for 859 ms. Opening the panel itself took a 139 ms frame, because every row re-split the whole 650 KB patch on every render.

## User flow

1. Open Changes. The list shows every file with its `+added −removed` counts, as before.
2. Expand a file with up to 1,000 changed lines: the diff renders as before.
3. Expand a larger file: a one-line notice says how many lines changed, with a **Show diff** button. Pressing it renders the full diff, and the user accepts the wait.

## Design

- `ChangedFiles` splits the combined patch once per rpc result (`useMemo`) into a `Map<path, { patch, added, removed }>`. Rows get their own slice and counts, so toggling a row does no string work.
- `ChangedFileRow` hides the diff when `added + removed > 1000` until the user presses Show diff. The choice is row state, so it lasts until the panel or the scope changes.
- Why 1,000: `PatchDiff` renders a whole file in one frame at about 0.07 ms per line (859 ms / 12.4k lines). 1,000 lines costs roughly 70 ms, a hitch but not a freeze. Hand-written changes past 1,000 lines in one file are rare; lockfiles, snapshots and generated code make up most of them.
- `@pierre/diffs` has no partial render for `PatchDiff`. `collapsed` hides the whole file and `tokenizeMaxLength` only skips highlighting, so we add our own guard.
- The unused `FilePatch` component, which had its own copy of the per-call split, is deleted.

## Out of scope

- Virtualizing the diff viewer. That would make Show diff fast too, but it changes how the panel scrolls.
- Skipping lockfiles by name. The line count already catches them and covers generated files we can't name.
- The one-time ~50 ms cost of the first diff rendered after a reload, which is highlighter warm-up.

## Verification

With `verify-hinacode`, point a thread's `turn_base_tree` at a repo whose working tree changes a large lockfile and 40 small files. Open Changes, expand the lockfile and then a small file. Sample `requestAnimationFrame` gaps: no frame should go over 32 ms except the first diff after a reload.
