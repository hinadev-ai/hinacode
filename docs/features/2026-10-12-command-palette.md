# Command palette

Status: Implemented
Date: 2026-10-12

## Problem

A developer with many projects and threads reaches them by scrolling the sidebar, and reaches app actions by remembering a shortcut or opening Settings. Each jump costs a mouse trip and a scan of a long list. There is no single keystroke that goes anywhere: a thread by name, a new thread in a given project, a command, or a file in the open thread's workspace.

## User flow

1. Press `mod+p` from anywhere, including while typing in the composer. A dialog opens near the top of the window with the search field focused.
2. With an empty field, recently run items come first, then threads in sidebar order, then "New thread in X" for each project.
3. Type to filter. Threads, projects and, when a thread is open, files in that thread's workspace are fuzzy matched and ranked together. Matched characters are highlighted. Results stay grouped under Threads, Projects and Files headings, and the group holding the best ranked item is listed first.
4. Type `>` as the first character, or press `mod+shift+p`, to list commands only. Each command shows its effective shortcut, including the user's rebinding.
5. Arrow keys move the highlight, Enter runs it, a click runs it. Escape closes and focus returns to where it was.
6. Running an item closes the palette, then:
   - a thread opens it,
   - a project starts a new thread there and focuses the composer,
   - a file opens in the file viewer of the open thread's Files panel,
   - a command runs exactly as its shortcut would.

## Design

Renderer only. No new rpc method, table or service.

- **Commands.** `palette.open` (`mod+p`) and `palette.commands` (`mod+shift+p`) join the registry in `keybindings/commands.ts`, so they are rebindable in Settings and checked for conflicts like every other command. Neither chord was bound before, and `mod+f` and `mod+shift+f` stay free for search. Shortcuts run on TanStack Hotkeys (see `docs/arch.md`, Keybindings). The palette lists the whole registry and runs each entry through the same `Command.run(ctx)` that `useKeybindings` calls, with the chord from `useKeymap()` drawn by `ChordKeys`. A command added to the registry shows up in the palette with no other change.
- **Module.** `src/renderer/palette/`:
  - `types.ts`: `PaletteItem`, `PaletteSource`, `PaletteContext` and `PaletteMode`. A source receives a `PaletteContext`, which is the `CommandContext` plus the keymap and the threads, so sources stay plain objects and the dialog re-asks them when that state changes.
  - `modes.ts`: the mode registry and group labels. A mode has a prefix (`""` for go to, `>` for commands), a placeholder and its sources. A new mode, such as global search, is one entry here plus its source; the dialog does not change. Code opens a mode with a prefilled query through `usePalette.getState().show(prefix + query)`.
  - `sources.tsx`: one source per group. Threads, projects and commands read the palette context. Files call the existing `files.list {threadId}` rpc.
  - `rank.ts`: a pure function from items, query and recent ids to ranked groups with highlight indexes. Recent items that match come first in recency order, then the rest by fuzzy score. Each group shows at most 50 items, which keeps a 50k-file repo cheap to render without virtualization.
  - `usePalette.ts`: zustand store for open state, the field's text and the recent ids.
- **Fuzzy matching.** `fuzzysort` 4 (8 kB gzip, maintained) over title, subtitle and keywords. It was picked over `fzf` (6 kB gzip, last release 2023). Measured on 50k synthetic paths where every path matches a one letter query: 4 to 29 ms per keystroke for the whole ranking, so the query goes through `useDeferredValue` and no worker is needed. Two things keep it there: recent items are partitioned out instead of sorting every match, and match indexes, which fuzzysort recomputes on each read, are read only for the 50 items per group that are shown.
- **Files.** `files.list {threadId}` already lists `ls-files --cached --others --exclude-standard` in the thread's active workspace (worktree or project root), capped at 50k, for the composer's `@` mentions. Reusing it keeps the trust boundary where it is: the renderer names a thread, main resolves the path, and no renderer-supplied path reaches git. The palette caches the result per thread for 5 seconds so typing does not run git on every keystroke. Files are offered only for a non-empty query, since a list of arbitrary files is noise.
- **Recent ids.** No settings field fits, so the last 20 run item ids are kept in `localStorage` through zustand `persist`. They are per machine and losing them costs nothing.
- **UI.** `components/CommandPalette.tsx`, mounted once in `AppShell`. It is the Base UI `Dialog` with an inline Base UI `Autocomplete` (`open`, `inline`, `filter={null}`, `autoHighlight="always"`), which gives `role="combobox"` on the input, `role="listbox"` and `role="option"` on results, a labelled `role="group"` per group, arrow keys and Enter. The input closes the dialog on Escape itself, because the always-open list would otherwise keep Escape. shadcn's `command` component was not used because its `base-nova` variant wraps `cmdk`, which pulls in Radix and filters on its own. The popup fades and scales in over 150 ms with `--ease-out`, has no motion under `prefers-reduced-motion`, and closes without animation so the chosen action runs at once.

## Out of scope

- Directory browsing. A separate change adds `fs.list` for a file explorer.
- Opening a file in an external editor. Mentioning a file stays with the composer's `@` completion and the file tree's context menu.
- Searching message content across threads.
- Syncing recent items across machines.

## Verification

- `palette/rank.test.ts` covers ranking: recent first, then fuzzy score, empty query order, the per-group cap and highlight indexes.
- `e2e/features/command-palette.feature` opens the palette with the shortcut, filters, and runs a command.
- With `verify-kkcode`: seed a project with threads, press `mod+p`, type part of a thread title and press Enter; open a thread, press `mod+p`, type part of a file name and check the file viewer shows it; press `mod+shift+p` and check that the shortcuts match Settings. Screenshots in light and dark.
