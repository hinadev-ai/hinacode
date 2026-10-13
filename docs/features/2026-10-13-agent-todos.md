# Agent tasks above the composer

## Problem

Agents keep a task list while they work (Claude `TaskCreate`/`TaskUpdate` and legacy `TodoWrite`,
Codex `update_plan`, Muse `write_todos`), but in kkcode it was only visible as raw tool rows in
the transcript. Codex's plan never arrived at all: the app-server sends it as a
`turn/plan/updated` notification, which the provider ignored.

## Design

The list already flows through the transcript as tool calls, and each call's result only
acknowledges it (Muse answers `{"ok":true,"revision":2,"items":6}`), so the renderer folds the
current list from the main agent's todo tool calls (`src/renderer/lib/todos.ts`):

- Replace-all tools (`write_todos`, `TodoWrite`, `update_plan`) carry the whole list in their
  input; the newest call wins.
- Claude's `TaskCreate`/`TaskUpdate` fold incrementally by task id, read from the
  `Task #N created` result.
- A sub-agent's calls (`parentCallId` parts) are ignored; their list is not the thread's.

The Codex provider stores each `turn/plan/updated` notification as an `update_plan` tool call,
so the plan persists with the transcript and renders through the same path. No new rpc method,
event or table.

Both CLIs now ship their todo tool off for current models. Codex 0.162 needs
`tools.update_plan.enabled`, which kkcode sets on every thread. Claude Code 2.1 offers
`TaskCreate`/`TaskUpdate` only to 4.x models unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=true`; kkcode
leaves that alone, so Claude threads on 5.x models show no task list.

`TodoBar` sits above the composer next to the sub-agent bar. Collapsed it shows
`{done} of {total} done` plus the in-progress task; expanding lists every task with a status
icon. It hides once every task is finished and the thread is idle.

## Out of scope

- Editing tasks from the UI.
- Per-sub-agent task lists in the Agents tab.

## Verification

- `src/renderer/lib/todos.test.ts` folds real captured inputs from all three agents.
- `KKCODE_MOCK_CLAUDE=todos` makes the simulated Claude emit a transcript-shaped
  `TaskCreate`/`TaskUpdate` sequence; `e2e/features/agent-todos.feature` drives it end to end
  without a real agent turn.
