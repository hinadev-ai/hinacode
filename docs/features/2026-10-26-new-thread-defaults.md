# New threads start as the last one was set up

Status: Shipped
Date: 2026-10-26

## Problem

A developer who works with one agent, model and effort sets them again on every new thread. Each new thread starts on Claude Code with the Settings default model, the model's own effort, and the project root. On the phone the same steps take more taps.

## User flow

1. The developer creates a thread, picks Codex, a model, an effort, an access mode, and ticks Worktree. Then they send the first message.
2. They open the new-thread palette from home. The project they last created a thread in is listed first, so Enter picks it.
3. The new thread's composer already shows the same agent, model, effort, fast mode and access mode, and Worktree is ticked on the default branch.
4. A thread made from the phone's New thread sheet or project header starts the same way.

Settings > Models shows the remembered default model and access mode, so it always matches what the next thread gets.

## Design

The existing `Settings` defaults are the memory. `defaultModel`, `defaultAccount` and `defaultAccessMode` were already there. `defaultProvider`, `defaultEffort`, `defaultFastMode` and `defaultWorkspaceMode` are new. Settings rows lay stored values over the defaults, so older profiles need no migration.

- `threads.update` and `threads.switchAccount` save the thread's options into those keys while the thread has no message. Changes after the first message stay on that thread.
- `threads.create` starts the thread from those keys. Switching agent on a thread restores that agent's remembered model, effort and fast mode.
- `threads.send` saves `defaultWorkspaceMode` after the first turn of a repository thread starts.
- The workspace stays a client draft until the first send, so each client ticks Worktree on create. Desktop does it in `startThread`, the phone in `lib/start-thread.ts`.
- The desktop caches Settings in an atom. Opening Settings refreshes it, so the page never saves stale defaults over remembered ones.

Automations and the MCP `create_thread` tool call `Threads.create` with their own agent and model, so they keep using only the access mode and account defaults.

## Out of scope

- Remembering the branch typed into the workspace picker. The next thread starts from the default branch, because the last branch is rarely the right base.
- Remembering choices per project. One set of defaults per environment keeps the model simple.

## Verification

`src/main/ipc.integration.test.ts` covers the remembered options, the workspace mode, and ignoring changes after the first message. In the app, set up and send a first message in one thread, then create another from the palette and from the phone, and compare the composers.
