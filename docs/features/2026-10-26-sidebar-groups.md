# Sidebar groups

Status: Shipped
Date: 2026-10-26

## Problem

The Threads tab lists every project in one flat column. A developer with work repositories, side projects and a few clouds scrolls past all of them to reach the one they want. They have no way to fold away the projects they are not using this week.

## User flow

1. Open a project's "…" menu (or right-click its row), then choose Move to group, then New group…. Name it and press Enter. The group appears at the top of the Threads tab with the project inside.
2. Move to group on another project lists the existing groups. Pick one to move the project there, or choose Remove from group to send it back to the ungrouped list.
3. Click a group's header to collapse or expand it. The header is a button with `aria-expanded`, so Tab and Enter work the same.
4. A group's "…" menu offers Rename…, Move up, Move down and Delete group. Deleting asks nothing, because the projects only return to the ungrouped list.
5. While the filter has a query, every group opens and groups without a match hide, the same way project rows behave.

Groups, their order, their collapsed state and their members survive a restart.

## Design

Groups are a field of `ClientSettings`, which `clientSettings.set` already persists as one JSON row in the `setting` table:

```ts
sidebarGroups: {
  groups: Array<{ id: string; name: string; collapsed: boolean }> // in sidebar order
  groupOf: Record<string, string> // project row key -> group id
}
```

- `groupOf` is a record, so a project is in at most one group by construction.
- Membership is keyed by the sidebar row key (`ProjectGroup.key`), the repository when there is one. A repository checked out on this desktop and on a cloud is one row, and it moves as one.
- `ClientSettings` is routed to this desktop and refused over remote. Groups organize this desktop's sidebar, so a cloud never stores them.
- The renderer changes groups with pure functions in `src/renderer/lib/sidebarGroups.ts` and saves the whole value. There is no new rpc method, table or migration.
- Group headers and project rows render as one flat keyed list. A project moved between groups stays mounted, so it keeps focus and its own collapsed state.

## Out of scope

- Drag and drop between groups. The menu covers it, and it works from the keyboard.
- Grouping the Chats project. It has no project menu.
- Groups on the phone app. Nothing there reads them yet.

## Verification

- `src/renderer/lib/sidebarGroups.test.ts` covers the operations and `arrangeRows`.
- `src/main/ipc.integration.test.ts` round-trips `sidebarGroups` through `clientSettings.set`.
- With `verify-hinacode`: create a group from a project menu, move a second project in and out, collapse, rename, move up, then `stop.sh` and `launch.sh --no-build` and check that the order and collapsed state held. Delete a group and check that its projects return to the ungrouped list.
