# Mention a thread with `@`

Status: Shipped
Date: 2026-10-14

## Problem

A developer running several threads often wants one agent to build on another's work: "review what @fix-login did", "pick up where @flaky-test stopped". Today they copy text between threads or paste a thread id they cannot see anywhere. The agent already has `list_threads` and `read_thread`, but nothing in the composer points it at a specific thread, and `read_thread` reports only the title and status, so the agent cannot tell which model ran it, where it worked, or what it shipped.

## User flow

1. In the composer, the developer types `@`. The suggestion list shows the project's other threads above the files, each with its agent icon, title and model. Typing filters both by title or path.
2. Arrow keys and Enter or Tab pick a thread. The composer inserts `@thread:<id>` and colors it like a file mention.
3. The sent message shows the mention as `@<title>`, a link that opens the thread.
4. The agent sees `@thread:<id>` in the prompt. Its hinacode instructions say this names another thread, so it calls `read_thread` with the id before acting on it.

## Design

The token is `@thread:<id>`, defined once in `src/shared/threadMention.ts` and used by the composer, the message view and the agent instructions. A full id needs no lookup or disambiguation in main.

Renderer:

- `ComposerInput` takes `threads` next to `files`. `@` suggestions list matching threads first, then files. The highlighter treats `@thread:<id>` of a known thread as a mention.
- `MessageList` renders `@thread:<id>` of a known thread in a user message as a link to that thread, labelled with its current title.
- Candidates are the non-archived threads of the same project, without the thread itself, from the `useThreads` store. No new rpc.

Main:

- `AGENT_INSTRUCTIONS` gains a "Threads" section explaining the token and pointing at `read_thread`.
- `read_thread` starts with two tagged blocks of `key: value` lines, so the agent can tell facts from transcript. `<metadata>` holds the thread id, title, status, provider, model, who created it, created and updated times, and the linked pull requests. `<environment>` holds the workspace: the project root, or a worktree with its branch and path. Each message heading carries its timestamp.

Persistence stays as it is. Messages, status, model and pull request links already live in SQLite (`message`, `thread`, `pull_request_link`), and `read_thread` reads them through `AgentRunner.transcript`. A turn is a user message and the assistant message after it, so there is no separate run id to store.

Trust boundary: `read_thread` still refuses threads of another project, so a mention cannot reach further than `list_threads` already does. The mention is plain prompt text and needs no new validation.

## Out of scope

- Mentioning threads of other projects. The MCP thread tools are scoped to one project on purpose.
- Inlining the mentioned thread's transcript into the prompt. The agent reads what it needs with `read_thread` and its `limit`.
- Pull request merge state in `read_thread`. The URL is enough for the agent to ask `gh`.

## Verification

- `mcp/server.integration.test.ts` checks the `read_thread` metadata block.
- `composerSyntax.test.ts` covers matching and highlighting thread mentions.
- With `verify-hinacode`, type `@` in a thread of a project with two threads, pick the other one, send, and check the rendered link and the agent's `read_thread` call.
