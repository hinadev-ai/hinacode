# Thread hierarchy

Status: Building
Date: 2026-11-03

## Problem

An agent that splits its work with `create_thread` leaves its helpers scattered through the sidebar. A developer running several of these at once can't tell which thread started which, so checking on one piece of work means reading titles and guessing.

## User flow

1. An agent calls `create_thread`. The new thread appears in the sidebar indented under the thread that created it.
2. If the agent passes `nested: false`, the new thread appears at the top level like any other thread. Agents do this for work that isn't part of their own task.
3. The developer opens, renames, pins, snoozes or archives a child like any other thread. Children can't be dragged, because they always sit right below their parent. Dragging the parent moves its children with it.
4. When the developer archives the parent, its children stay open and become ordinary top-level threads. Unarchiving the parent does not nest them again.

## Design

**Data.** `thread.parent_id` (migration `0039_thread_parent`) points at the parent thread, and `ON DELETE SET NULL` releases the children when the parent is deleted. `Thread.parentId` decodes to `null` when a peer on an older build omits it.

**One level.** `Threads.create` takes a `parentId`, and when that thread already has a parent it stores the parent's parent instead. A thread created from a child therefore joins its siblings, and a child never has children of its own. Sub-agents inside a child thread are unaffected, because they are part of its turn, not threads.

**Archive.** `Threads.archive` clears `parent_id` on the archived thread's children and publishes `thread.updated` for each one, so every open window moves them to the top level at once. Clearing the column, instead of hiding the link while the parent is archived, keeps the one-level rule true. A former child can then have children of its own.

**Sidebar.** `nestChildren` (`renderer/lib/threadTree.ts`) orders each list so that children follow their parent, and marks them for the indent. A child nests only when its parent is in the same list. A pinned child, a snoozed parent, or a search that matches only the child all show the child at the top level, and no thread is ever hidden.

**MCP.** `create_thread` takes `nested`, which defaults to true. Threads created on another machine ignore it, because the parent lives in a different database.

## Out of scope

- Nesting in the mobile app. It lists threads flat.
- Choosing or changing a parent from the UI. The relationship comes from the agent that created the thread.
- Archiving children along with their parent. Each thread stays in the developer's hands.

## Verification

`Threads.integration.test.ts` covers the one-level rule and archive detaching the children. `mcp/server.integration.test.ts` covers `nested` on `create_thread`, and `threadTree.test.ts` covers the sidebar ordering. In the real app, launch `verify-hinacode` with `HINACODE_MOCK_AGENTS=thinking`. Call `create_thread` with `mcp-call.ts` from a seeded thread, once with the default and once with `nested: false`. Screenshot the sidebar, archive the parent, and screenshot again.
