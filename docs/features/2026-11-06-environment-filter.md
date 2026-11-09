# Environment filter

Status: Building
Date: 2026-11-06

## Problem

A developer with this machine and one or more paired clouds, or a phone paired with several machines, sees every environment's threads in one list. The same repository is often cloned on more than one of them, so the project filter cannot separate them. A worker machine full of background threads buries the few threads they are steering here, and a machine that is switched off overnight still fills the list with threads nobody can act on.

## User flow

Desktop, and the browser app, which runs the same renderer:

1. The filter button in the sidebar's search field opens one menu. With two or more environments it starts with **Environments**. That section has `All environments`, one checkbox per environment, and `Hide offline environments`. This machine comes first, then each cloud, with its status beside it while it is not connected. **Projects** follows, as before.
2. Checking environments narrows every sidebar list to them. That covers pinned, the inbox's ready, working and snoozed sections, the settled and archived shelves, drafts, the projects tab and sidebar search. The Projects section of the menu lists only projects on the shown environments. The filter icon fills while anything is hidden.
3. `Hide offline environments` drops an environment while its status is `offline` and brings it back when it reconnects, with no further clicks.
4. The choice survives reloads and restarts.

Phone:

1. With several machines paired, a row of chips sits above the Inbox, Threads and Archived tabs and stays above search results: `All`, then one chip per machine. A machine that is not connected shows the offline icon.
2. Tapping a chip narrows the list and search to the picked machines. `All` clears the picks.
3. Settings has a switch that hides offline machines automatically.

## Design

`src/shared/environmentFilter.ts` holds the one model both apps persist and evaluate:

```ts
{ environmentIds: Array<string | null>, hideOffline: boolean }
```

- `environmentIds` is an inclusion list, the same shape as the project filter: empty means every environment. `null` is this machine.
- `shownEnvironmentIds` falls back to every environment when none of the picked ids exists any more. Removing a cloud never leaves an empty list, and nothing has to prune the stored ids.
- With fewer than two environments it shows everything. The menu and the chips hide then, so a stored `hideOffline` must not hide the only machine with no way to turn it off.
- Offline means status `offline` only. `connecting` is shown, so nothing flickers away at launch. `unauthorized` and `incompatible` are shown, because they need the user to act.

Desktop. `sidebarFilter.ts` lists the environments and applies the environment filter before the project pick. It lists this machine only when a project lives on it, so the browser app never shows it. A picked project on a hidden environment therefore falls back to every shown project instead of an empty list, and its pick comes back when its environment does. Nothing is reset or erased. A project whose environment the sidebar does not know stays visible. The renderer keeps the filter in `localStorage` under `hinacode.sidebarEnvironments` and decodes it with the schema, so a broken value falls back to every environment.

Phone. The filter lives in the phone's `Preferences`, next to the home tab. It decodes with a default, so preferences an older app stored still load. The home list and search results filter at their data source, so every section agrees.

No rpc method, table or main-process code changes. The filter is a view preference of one device, so the desktop and the phone keep their own.

## Out of scope

- The command palette's thread search ignores the filter, so a hidden thread is always one jump away.
- The Inbox tab's count, the dock badge and the overview screens still count every environment. They ignore the project filter today, and the two filters should agree.
- Showing status and environment on sidebar search results is a separate request.
- Message search on the phone filters after the server's 30-hit limit, so a narrowed search can return fewer hits.
- Syncing the filter between devices.

## Verification

- `src/shared/environmentFilter.test.ts` and `src/renderer/lib/sidebarFilter.test.ts` cover the model, the fallbacks and the order of the two filters. The phone's preference decoding and list filtering have tests under `apps/mobile/src/lib`.
- In the real app, pair a `hinacode serve` cloud as `.agents/skills/verify-hinacode/features/remote.md` describes, add projects on both machines, then pick the cloud, search, pick a local project while the cloud is picked, turn on `Hide offline environments` and stop the cloud, restart the desktop, and start the cloud again.
