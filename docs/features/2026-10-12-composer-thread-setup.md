# Thread setup in the composer

Status: Building
Date: 2026-10-12

## Problem

Starting a thread meant filling in a dialog: title, agent, model, worktree toggle, branch and base ref. Most of these fields have a good default or are better decided after you write the prompt. The title is the worst one, since you have to describe the task before you've written it.

## User flow

1. Press `mod+n` or the `+` next to a project. A thread opens at once with a placeholder title like `thread-q3qcy`, and the composer has focus.
2. While the thread has no messages, the model picker lists every agent's models under the agent's name, so picking a Codex model switches the thread to Codex in one step. Its trigger shows the agent as an icon and the model by name. Below the input is a workspace picker: `Local` or `New worktree`. `New worktree` adds a base ref input that defaults to the project's current branch.
3. Send the first message. With `New worktree`, main creates the worktree on branch `kk/thread-q3qcy` before the turn starts.
4. In the background, the text generation model reads the message and returns a title and a branch slug. The thread is renamed, and the branch becomes `kk/<slug>`.
5. After the first message the workspace picker disappears, and the model picker lists only the thread's agent. To use another agent, start a new thread.

## Design

- `threads.create` takes only `projectId`. Main picks a random title, the `claude` agent, and that agent's default model (the user's setting, else the first model the agent lists).
- `threads.update` accepts `provider`, with the picked `model` or else that agent's default model. `Threads.update` refuses a provider change once the thread has a message (`ThreadStartedError`).
- `threads.send` accepts `workspace: { mode, target }`. `AgentRunner.send` passes it to `Threads.prepareWorkspace`, which also refuses once the thread has a message or a worktree. See `2026-10-14-workspace-ref-picker.md`.
- `ThreadNaming` makes one Claude Agent SDK call with no tools, low effort and JSON schema output. It updates the title only if it's unchanged, then calls `Worktrees.renameBranch` (`git branch -m`). The checkout path keeps the placeholder name. Any failure is logged and the placeholder names stay.
- `settings.textGenerationModel` defaults to `claude-sonnet-5-5` and can be changed in Settings → Models.
- The workspace choice lives in the renderer's in-memory draft until the message is sent.

## Out of scope

- Naming with Codex. The text generation model is a Claude model.
- Moving a thread that has started into a worktree, or changing its agent.
- Branch pickers. The base ref is a text field, like before.

## Verification

- `ipc.integration.test.ts`: a thread is created with the default agent and model, and switches agent only before its first message.
- `Worktrees.integration.test.ts`: a new worktree branches from the title and `renameBranch` moves the checkout's branch.
- `verify-hinacode`: create a thread, switch to `New worktree`, send a message, and see the title and branch change in the sidebar and side panel.

## Effort and fast mode

The thread stores `effort` (null means the model's default) and `fastMode` (migration `0004`). `models.list` reports each model's `efforts`, `defaultEffort` and `fastMode`, so the composer only shows the controls a model supports. Changing model drops values the new model can't honor, and switching agent resets both. Claude gets them as the `effort` option and `settings.fastMode` at session start, and through `applyFlagSettings` when they change. Codex gets `effort` and `serviceTier: "priority"` (its "Fast" tier) on `turn/start`.

## Access modes

Each thread has an `accessMode` (migration `0005`), picked in the composer's `Access` select. New threads start `supervised`, and the mode can change at any time, including mid-thread.

| Mode       | Claude `permissionMode`                                | Codex approval policy, sandbox  |
| ---------- | ------------------------------------------------------ | ------------------------------- |
| Supervised | `default`                                              | `untrusted`, `workspace-write`  |
| Auto       | `auto`, or `acceptEdits` if the model has no auto mode | `on-request`, `workspace-write` |
| Full       | `bypassPermissions`                                    | `never`, `danger-full-access`   |

- `models.list` reports `autoMode` per model (Claude's `supportsAutoMode`), so the Auto item says what it will actually do.
- Claude sessions always start with `allowDangerouslySkipPermissions`, which only makes `bypassPermissions` reachable. The permission mode decides what runs unasked. That lets a live session move to full access with `setPermissionMode` instead of restarting. A change reaches a running Claude turn at once, and is applied before each turn otherwise.
- Codex gets the mode on `thread/start` and `thread/resume`, and again on `turn/start`, since resuming a loaded thread ignores overrides. `turn/start` replaces the sandbox only when its kind changes: the replacement is a whole policy and would drop the user's `sandbox_workspace_write` config.
- Full access uses the destructive color in the trigger. Amber means a thread is waiting on you, and a full-access thread never waits; the risk is that destructive commands run without a check.

Out of scope: a default access mode for new threads in Settings, and per-project defaults. Automations start threads `supervised` like everything else.

## Highlighting and completion

- **Highlighting.** The textarea's text is transparent, and a highlighted copy of the same text sits under it (`ComposerInput`, `shared/composerSyntax.ts`). It colors list markers, inline and fenced code, known commands and mentions of files that exist. Only color changes, never font or spacing, so both layers wrap the same way.
- **Completion.** `/` completes Claude slash commands and skills (`commands.list`: the live session's `supportedCommands()`, or a throwaway CLI in the thread's directory, cached for a minute). `$` completes Codex skills (`skills/list`), and a sent `$name` also goes to Codex as a `skill` input item. `@` completes workspace files (`files.list`: `git ls-files --cached --others --exclude-standard`, refreshed after each turn). Arrow keys move, Enter or Tab inserts, Escape closes.
