# Thread setup in the composer

Status: Building
Date: 2026-10-12

## Problem

Starting a thread meant filling in a dialog: title, agent, model, worktree toggle, branch and base ref. Most of these fields have a good default or are better decided after you write the prompt. The title is the worst one, since you have to describe the task before you've written it.

## User flow

1. Press `mod+n` or the `+` next to a project. A thread opens at once with a placeholder title like `thread-q3qcy`, and the composer has focus.
2. While the thread has no messages, the composer shows an agent picker next to the model picker, and below the input, a workspace picker: `Local` or `New worktree`. `New worktree` adds a base ref input that defaults to the project's current branch.
3. Send the first message. With `New worktree`, main creates the worktree on branch `kk/thread-q3qcy` before the turn starts.
4. In the background, the text generation model reads the message and returns a title and a branch slug. The thread is renamed, and the branch becomes `kk/<slug>`.
5. After the first message the agent and workspace pickers disappear. To use another agent, start a new thread.

## Design

- `threads.create` takes only `projectId`. Main picks a random title, the `claude` agent, and that agent's default model (the user's setting, else the first model the agent lists).
- `threads.update` accepts `provider` and switches to that agent's default model. `Threads.update` refuses a provider change once the thread has a message (`ThreadStartedError`).
- `threads.send` accepts `worktree: { baseRef }`. `AgentRunner.send` passes it to `Threads.attachWorktree`, which also refuses once the thread has a message or a worktree.
- `ThreadNaming` makes one Claude Agent SDK call with no tools, low effort and JSON schema output. It updates the title only if it's unchanged, then calls `Worktrees.renameBranch` (`git branch -m`). The checkout path keeps the placeholder name. Any failure is logged and the placeholder names stay.
- `settings.textGenerationModel` defaults to `claude-sonnet-5-5` and can be changed in Settings → Models.
- The workspace choice lives in the renderer's in-memory draft until the message is sent.

## Out of scope

- Naming with Codex. The text generation model is a Claude model.
- Moving a thread that has started into a worktree, or changing its agent.
- Branch pickers. The base ref is a text field, like before.

## Verification

- `ipc.integration.test.ts`: a thread is created with the default agent and model, and switches agent only before its first message.
- `Worktrees.integration.test.ts`: `attachWorktree` branches from the title and `renameBranch` moves the checkout's branch.
- `verify-kkcode`: create a thread, switch to `New worktree`, send a message, and see the title and branch change in the sidebar and side panel.
