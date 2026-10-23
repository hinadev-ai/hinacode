# Activity indicator

Status: Building
Date: 2026-10-23

## Problem

An agent leaves work running that the transcript does not show well. Claude Code starts shells with `run_in_background` (a dev server, a test watcher) that keep running after the tool call and after the turn. HinaCode tracked them only to keep the CLI alive, so the developer could not see them or stop one without stopping the whole thread. The todo list and the sub-agent bar sat above the composer as two loose lines, and a third kind of activity would have been a third.

## User flow

1. The agent plans tasks, spawns sub-agents or starts a background shell.
2. A tray docks on top of the composer. It lists, top to bottom, the plan ("1 of 3 done" and the task in progress), the sub-agents in flight, and one line per background task with its label, how long it has run, and a stop button.
3. The turn ends. The plan stays while it is unfinished, the sub-agent line goes, and background tasks stay until they exit or the developer stops them.
4. Stop on a background task ends that task only. The turn and the other tasks keep going.
5. The tray never grows past about a third of the thread's height. A long plan scrolls inside its own section, and the tray scrolls past that.
6. When nothing is left, the tray is gone.

The plan line expands with Enter or Space. Each stop button is in the tab order and is named "Stop <label>".

## Design

- `BackgroundTask { id, kind: shell | workflow | other, label, startedAt }` in `src/shared/agent.ts`. Sub-agents stay `Subagent`.
- `AgentProvider.backgroundTasks` is optional and pairs `changes`, a stream of `{ threadId, tasks }` with replace semantics, with `stop(threadId, taskId)`. A provider cannot list tasks it cannot stop.
- Claude maps the CLI's `background_tasks_changed` snapshot in `backgroundTasksOf` (`agents/claude/mapMessage.ts`). It drops `local_agent` tasks, which are sub-agents, and `ambient` ones, which the CLI says are not activity. Stop calls `query.stopTask`. Closing the CLI session emits an empty set, because its shells end with the process.
- `AgentRunner` keeps the latest set per thread in memory and pushes `thread.backgroundTasks`. `backgroundTasks.list` loads it and `backgroundTasks.stop` stops one. Both route to clouds like `subagents.*`.
- The renderer keeps them in `stores/backgroundTasks.ts`. `ActivityIndicator` is the tray. `TodoActivity`, `SubagentActivity` and `BackgroundTaskActivity` are its sections, each built from `ActivityRow` and each rendering nothing when empty, so the tray hides with `:empty`.

## Out of scope

- Reading a background task's output. The agent reads it with its own tools, and the terminal drawer is the place for a shell the developer wants to watch.
- Persisting tasks across an app restart. The CLI that owns them does not survive one.
- Moving a running foreground command to the background from the UI.

## Verification

- `e2e/features/agent-activity.feature` drives the `activity` mock Claude scenario. The tray shows the plan, a sub-agent and two shells, one shell stops on its own, and the other outlives the stopped turn.
- `mapMessage.test.ts` covers the snapshot mapping. `claude/index.test.ts` covers the change stream, `stopTask` and the empty set when the CLI exits.
- For a real run, ask Claude in a verify-hinacode instance to start `sleep 600` with `run_in_background`, then stop it from the tray.
