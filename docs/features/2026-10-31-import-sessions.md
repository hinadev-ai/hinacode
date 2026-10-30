# Import sessions started outside HinaCode

Status: Building
Date: 2026-10-31

## Problem

A developer runs `claude` or `codex` in a terminal, gets halfway through a task, and wants to carry on in HinaCode with its worktrees, approvals and pull request links. Today HinaCode only knows sessions it started. The terminal session can't be reached from the app, so the developer either stays in the terminal or starts over and pastes a summary.

Other harnesses show how this goes wrong. One only offers import during onboarding, so a session started later can never be imported. Another imports only the last 200 messages and does not say so. Users ask for native resume, with replay only as a fallback that the app discloses.

## User flow

1. The developer opens a project's "…" menu in the sidebar and picks **Import session…**. From the keyboard, the command palette has **Import session…**. It asks for the project first, with the open thread's project on top, like the `+` new thread picker.
2. A dialog lists the Claude Code and Codex sessions recorded in that project's folder, newest first. Each row shows the agent, the session's title, the first prompt and when it was last active. When a session came from an added account, the row names the account. Typing filters the list, and arrow keys and Enter pick a row.
3. A session that is already a HinaCode thread says **Open**, and picking it opens that thread.
4. Picking any other session creates a thread in the project root and opens it. The transcript shows the earlier conversation, every message, with tool calls and file edits shown the same way as in a live turn. A rule at the end says "Imported from Claude Code". The next message resumes that same session, so the agent keeps its full context.
5. When HinaCode can find the session but can't read its history, the thread still imports. It shows only the rule, which says the earlier messages couldn't be shown and that the agent still has them. HinaCode doesn't invent history.
6. When the session has disappeared since the list loaded, the import fails with an error toast and no thread is created.

## Design

### Data

- `AgentProvider` gains two optional methods, implemented by Claude and Codex. Muse has no agent home and leaves them out.
  - `listSessions(cwd, home)` returns `NativeSession { sessionId, title, preview, branch, updatedAt }` for sessions whose recorded cwd is exactly `cwd`, newest first, capped at 50 per home.
  - `readSession(sessionId, cwd, home)` returns `{ model, messages }`. `messages` is the whole transcript as `ImportedMessage { role, parts, createdAt, completedAt, forkPoint }`, or null when the session exists but its history can't be read. It fails with `AgentError` when the session is gone.
- `ExternalSession` (shared) is a `NativeSession` plus `provider`, `accountId`, and `threadId`. `threadId` is set when a thread is already bound to the session.
- `MessagePart` gains `session_import { provider, history: "replayed" | "unavailable" }`. It renders as a rule, like `agent_switch`, and it is how the UI says "resume only" without faking messages. It also makes `Threads.started` true, so the thread can't move into a worktree. A Claude session only resumes from the cwd it was recorded in.

### Reading sessions

- **Claude.** The Agent SDK already has `listSessions` and `getSessionMessages`, which pick titles, drop sidechains and walk the `parentUuid` chain to the current branch. They read only the config dir the process started with, so HinaCode passes them a read-only `SessionStore` over the account home's `projects/` folder. `limit` keeps the listing to 50 file reads. The store also keeps each entry's timestamp by uuid, since `SessionMessage` has none.
- **Codex.** The app-server already has `thread/list` with a `cwd` filter and `thread/read` with `includeTurns`. The provider calls them on the app-server of the account's home, which it already runs for turns. Its items have the same `ThreadItem` shape as live notifications, so tool calls reuse `toolName`, `toolInput` and `toolResult`.
- Both converters fold their native records through `foldEvent`, the same fold a live turn uses, so an imported transcript renders exactly like one HinaCode ran. Each completed turn gets a `forkPoint`, so the fork button works on imported turns too.

### Service and rpc

- `SessionImports` (`src/main/services/SessionImports.ts`) owns both calls.
  - `list(projectId)` asks every provider that has `listSessions`, for the CLI's own home and each added account, in parallel. A session can sit in several homes after an account switch copied it. HinaCode keeps the most recently active copy. A home that fails, for example because Codex is not installed, becomes an entry in `failures` and the rest still lists.
  - `import({ projectId, provider, sessionId, accountId })` returns the bound thread when one exists, so importing twice is safe. Otherwise it reads the session first. In one SQL transaction it creates the thread in the project root, sets `accountId` to the home the session lives in and `providerSessionId` to the session, and inserts the messages and the `session_import` rule. If the read or any insert fails, nothing is written. The thread's next turn passes `providerSessionId` as `resumeSessionId` like any other turn, and switching accounts later copies the session with `copySession` as usual.
- rpc: `sessions.listExternal { projectId } → { sessions, failures }` and `sessions.import { projectId, provider, sessionId, accountId } → Thread`. Both requests are decoded by the contract schemas. The contract accepts only a UUID as the session id. Claude uses it as a file name, so a crafted id can't name a path outside the home.
- Only `folder` projects import. A chat project's threads each get their own folder, which no terminal session ran in.

### UI

- `ImportSessionDialog` mounts once in the app shell and opens from `useUi.importSessionProjectId`.
- The project menu sets it directly. The `session.import` command opens the palette in a new `<` mode that lists projects, and picking one opens the dialog.

## Out of scope

- Live mirroring of a session that is still running in a terminal. Import is a snapshot plus native resume. If both keep writing to the same session, the agent's own rules apply.
- Sessions recorded in subfolders or other worktrees of the project. Claude resumes only from the recorded cwd, and HinaCode threads run in the project root or their own worktree.
- Muse sessions. Muse has no agent home to scan.
- Sub-agent transcripts. The parent's tool call for each sub-agent is imported with its result, but not the sub-agent's own steps.
- Paging past 50 sessions per home. The dialog is for recent work.

## Verification

- `src/main/agents/claude/sessions.test.ts` lists and reads a real Claude transcript fixture in a temp home: titles, cwd filtering, the active branch of a rewound conversation, tool results, compaction, and a missing session.
- `src/main/agents/codex/index.integration.test.ts` lists and reads a thread through the fake app-server.
- `src/main/services/SessionImports.integration.test.ts` imports into a real SQLite DB: replayed history with no message cap, the resume-only rule, re-import returning the same thread, and a vanished session leaving no thread behind.
- With `verify-hinacode`: run `claude -p` in a scratch project, import the session from the project menu, screenshot the replayed transcript, send a follow-up that depends on the earlier turn, and screenshot the answer.
