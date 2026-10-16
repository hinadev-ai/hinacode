# MCP tools: request a secret, start and follow up on threads

Status: Shipped
Date: 2026-10-12

## Problem

An agent working in a thread sometimes needs two things only the user can give: a credential (an API token for a service it is integrating, a webhook signing secret) and more hands (a second thread to take a side task while it keeps going). Today it has to stop and ask in prose. The user pastes the token into the chat, where it lands in the transcript, the provider's session log and the model's context. Starting a sibling thread means the user leaves the conversation, clicks New thread, and types the brief themselves.

## User flow

Request a secret:

1. The agent calls `request_secret({ name: "stripe.apiKey", description: "Stripe test key for the webhook fixture" })`.
2. A card appears in the thread, below the transcript, with the description, the secret name, a masked input and two buttons: Save and Decline. The sidebar shows the thread as waiting, the same way it does for a tool approval. If a secret with that name already exists, the card says so and the button reads Replace.
3. The user types the value and presses Enter or Save. The card disappears and the tool returns `Stored secret "stripe.apiKey". The value is never returned to you; tell the user which setting or environment variable needs it.` Decline returns an error result instead.
4. If the turn ends first (interrupted, failed, finished), the card disappears and the tool returns an error result.

Keyboard: the card does not steal focus from the composer. Tab reaches the input, Enter saves, and the Decline button is one more Tab away.

Start a thread:

1. The agent calls `create_thread({ title, prompt, provider?, model?, worktree?: { branch, baseRef } })`.
2. The new thread appears in the sidebar of the same project right away, running its first turn with `prompt`. With `worktree`, it runs in a new worktree on `branch` forked from `baseRef`, after the project's setup script.
3. The tool returns the new thread's id and title.

## Design

Both tools run on the built-in MCP server, so the calling thread comes from the request's credential and nothing else.

`request_secret` is a user prompt that blocks a tool call, which is exactly what tool approvals already are. It reuses that path end to end:

- `AgentRunner.requestSecret(threadId, name, description)` creates a `SecretRequest` `{ id, threadId, name, description }`, emits a `secret_requested` agent event into the running turn and waits. With no turn running it fails at once: there is nobody to show the card to.
- `secret_requested` and `secret_resolved` join the `AgentEvent` union next to `approval_requested` and `approval_resolved`. They move the thread between `awaiting_approval` and `running`, reach the renderer as `thread.event` pushes with a `seq`, and `threads.transcript` returns the pending ones, so a reopened thread shows its card again. They are the only agent events the provider does not produce; the MCP server does.
- The renderer answers over a new rpc, `secrets.respond({ requestId, value })`, with `value: null` for Decline. The main process stores the value through `Secrets.set(name, value)` and only then resolves the request. The value crosses one boundary, renderer to main, and is never put in an event, a tool result, a message or a log.
- When the turn finishes, the runner fails every open request of the thread, so the tool returns an error and the MCP call does not hang.

`create_thread` is `Threads.create` plus `AgentRunner.send`, the same two calls an automation makes:

- Defaults come from the calling thread: its project, provider and model. `worktree` is passed through unchanged.
- The thread is created with `created_by = thread:<callerId>`. The child is an ordinary thread of the project. It has its own worktree or none, its own turns and its own lifecycle. Archiving or deleting the parent does nothing to the child. `created_by` is provenance, not ownership: it answers "where did this thread come from" in the same way `automation:<id>` does.
- The runner publishes `thread.updated` before starting the turn, so the sidebar shows the thread in the moment it is created.

An agent that started threads needs to follow up on them, so four more tools sit next to `create_thread`:

- `list_threads` returns the non-archived threads of the caller's project as JSON, with status, provider, model, `created_by`, the worktree branch, and `self` on the caller.
- `read_thread({ threadId, limit? })` returns the status, the metadata listed in `2026-10-14-thread-mentions.md`, any pending approval, question or secret request, and the last `limit` messages (20 by default, at most 100) as plain text. Reasoning is left out.
- `send_to_thread({ threadId, prompt })` steers a busy thread and starts a turn on an idle one, and says which it did.
- `stop_thread({ threadId })` interrupts the thread's turn.

They reach any thread of the caller's project, not only its children, because `created_by` is provenance and not ownership. A thread of another project is refused. `send_to_thread` and `stop_thread` also refuse the caller itself.

Services: `AgentRunner` now depends on `Secrets`. The MCP server now depends on `AgentRunner`, `Threads` and `Events`. The runner used to depend on the server for a thread's credential, which would make a cycle, so the credential store moves into its own service, `McpCredentials` (`src/main/mcp/credentials.ts`). It issues credentials, authenticates requests and learns the server URL once the listener is up. The server's HTTP layer and the runner both depend on it and not on each other.

Codex times MCP tool calls out after 60 seconds by default. The hinacode server is configured with `tool_timeout_sec = 600` in the thread overrides, so a user has ten minutes to find and paste a secret. Claude Code's MCP tool timeout is already long enough.

## Out of scope

- Per-thread or per-project secrets. Secrets stay global, keyed by name, exactly as Settings stores them.
- Cascading lifecycle for child threads. A parent that is archived leaves its children alone.
- Limits on how many threads an agent may start. The user sees every one of them in the sidebar.

## Verification

Tests: `src/main/mcp/server.integration.test.ts` runs both tools over HTTP with the real MCP client against the real runner, with a fake agent provider whose turn stays open until the test ends it. It covers the stored and declined answers, the turn ending first, calling with no turn running, the defaults `create_thread` takes from its caller, and that the secret value never appears in a push or a tool result. `src/renderer/stores/messages.test.ts` covers folding the two events into a thread's pending requests.

Real app, with `verify-hinacode`: create a project and a thread, start a cheap Claude turn whose prompt asks it to call `request_secret`, screenshot the card, answer it, and confirm with `secrets.has` that the value landed and with `threads.transcript` that no event or message contains it. Then ask it to call `create_thread` and screenshot the sidebar with the new thread running.
