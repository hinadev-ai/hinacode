# Agent providers

An `AgentProvider` owns one agent backend. It owns the child process or SDK session. It translates the native protocol into the shared `AgentEvent` union. Everything after the provider is agent-agnostic. This page lists each capability the harness relies on. It says how each capability reaches the UI. It says which providers have it. An engineer adding a backend works through the checklist at the end so nothing is silently missing.

The contract lives in `src/main/agents/provider.ts`. The event union lives in `src/shared/agent.ts`. The three implementations are `src/main/agents/claude/index.ts`, `src/main/agents/codex/index.ts` and `src/main/agents/muse/index.ts`.

## Capability matrix

A cell says yes when the provider maps the capability today. A cell says no when it does not. The native name follows the answer where it helps.

| Capability                       | Contract                                                    | Claude             | Codex                    | Muse               | What the UI shows                              |
| -------------------------------- | ----------------------------------------------------------- | ------------------ | ------------------------ | ------------------ | ---------------------------------------------- |
| Models                           | `listModels`                                                | yes                | yes                      | yes                | Model picker in the composer                   |
| Account and plan limits          | `account`, `planLimits`                                     | yes                | yes                      | yes                | Account settings and the account picker        |
| Token usage                      | `usage`, `turn_completed.usage`                             | yes                | yes                      | yes                | Thread usage and context meter                 |
| Context breakdown                | `contextBreakdown`                                          | yes                | no                       | no                 | Categories in the context meter popover        |
| Commands and skills              | `listCommands`                                              | yes                | yes                      | yes                | Slash and dollar completion in the composer    |
| Streaming text and reasoning     | `text_delta`, `reasoning_delta`                             | yes                | yes                      | yes                | Streaming reply in the transcript              |
| Tool calls and file changes      | `tool_call_started`, `tool_call_finished`, `file_changed`   | yes                | yes                      | yes                | Tool rows and the changes view                 |
| Approvals                        | `approval_requested`, `respondApproval`                     | yes, `canUseTool`  | yes                      | yes                | Inline approval card                           |
| Questions                        | `question_requested`, `respondQuestion`, `questions_posted` | yes, blocking only | yes, blocking and posted | yes, blocking only | Question card in the transcript                |
| Steering a running turn          | `steer`                                                     | yes                | yes, `turn/steer`        | yes, `turn/steer`  | New user message inside the running turn       |
| Interrupt                        | `interrupt`                                                 | yes                | yes, `turn/interrupt`    | yes                | Stop button ends the turn                      |
| Auto-compaction                  | `compaction_updated`, `autoCompactTokens`                   | yes                | yes                      | yes                | Compaction row in the transcript               |
| Todos and plan                   | Todo tool calls in the transcript                           | yes                | yes                      | yes                | Plan section of `ActivityIndicator`            |
| Sub-agents                       | `subagent_updated`, `stopSubagent`                          | yes                | yes                      | yes                | Sub-agent section of `ActivityIndicator`       |
| Background tasks                 | `backgroundTasks.changes`, `backgroundTasks.stop`           | yes                | yes, polled              | yes                | Background task section of `ActivityIndicator` |
| Turns the agent starts by itself | `wakes`                                                     | yes                | no                       | yes                | A reply with no user message before it         |
| Access mode                      | `accessMode`, `setAccessMode`                               | yes, live          | yes, next turn           | yes, live          | Access picker in the composer controls         |
| Session copy between accounts    | `copySession`                                               | yes                | yes                      | no                 | Account switch on a started thread             |
| Closing a session                | `closeSession`                                              | yes                | yes                      | yes                | Agent switch on a started thread               |
| Fork from a turn                 | `turn_completed.forkPoint`, `RunTurnInput.forkAt`           | yes                | yes                      | no                 | Fork button under a reply                      |

### Notes on the rows that differ

**Models, account, limits, usage, commands.** All three implement `listModels`, `account`, `planLimits`, `usage` and `listCommands`. See the returns at `src/main/agents/claude/index.ts`, `src/main/agents/codex/index.ts` and `src/main/agents/muse/index.ts`. `planLimits` returns null when an account has no plan windows (`src/main/agents/provider.ts`). `usage` reads transcripts from the account home and returns null when there is no transcript (`src/main/agents/provider.ts`).

**Streaming, tools, files.** All three emit `text_delta` and `reasoning_delta`. Claude maps them in `src/main/agents/claude/mapMessage.ts`. Codex maps them in `src/main/agents/codex/index.ts`. Muse maps them in `src/main/agents/muse/index.ts`. All three emit `tool_call_started`, `tool_call_finished` and `file_changed`. A sub-agent tool call also carries `parentCallId` (`src/shared/agent.ts`).

**Approvals and questions.** All three map approvals to `approval_requested` and answer through `respondApproval`. Codex emits it at `src/main/agents/codex/index.ts`. Muse emits it at `src/main/agents/muse/index.ts`. A `question_requested` blocks the turn until `respondQuestion` answers it. Codex also emits `questions_posted` at `src/main/agents/codex/index.ts`. That variant never blocks the turn (`src/shared/agent.ts`). The user answers it with the next message.

**Steering and interrupt.** All three implement `steer` and `interrupt`. `steer` fails when no turn is running (`src/main/agents/provider.ts`). Codex interrupts with `turn/interrupt` (`src/main/agents/codex/index.ts`). Claude interrupts the SDK query (`src/main/agents/claude/index.ts`).

**Auto-compaction.** All three emit `compaction_updated` with the full current state (`src/shared/agent.ts`). The state is `running`, `done` or `failed` (`src/shared/agent.ts`). The threshold arrives as `autoCompactTokens` on `RunTurnInput` (`src/shared/agent.ts`). Null keeps the agent threshold. Claude passes it to the SDK as `autoCompactWindow` (`src/main/agents/claude/index.ts`). Claude reports state from `status` and `compact_boundary` messages (`src/main/agents/claude/mapMessage.ts`). Codex passes it as `model_auto_compact_token_limit` (`src/main/agents/codex/index.ts`). Codex reports `contextCompaction` items (`src/main/agents/codex/index.ts`). Its `done` state is always `auto` with null token counts (`src/main/agents/codex/index.ts`). Muse reports `compaction` items (`src/main/agents/muse/index.ts`). MSP takes no threshold. HinaCode therefore compares the latest context size itself and calls `session/compact` before the turn (`src/main/agents/muse/index.ts`).

**Todos and plan.** There is no todo event. The renderer folds todo tool calls from the transcript in `src/renderer/lib/todos.ts`. Muse `write_todos`, Claude `TodoWrite` and Codex `update_plan` each carry the whole list, so the newest call wins (`src/renderer/lib/todos.ts`). Claude `TaskCreate` and `TaskUpdate` fold incrementally by task id (`src/renderer/lib/todos.ts`). Codex has no todo tool call. Its provider turns each `turn/plan/updated` notification into a synthetic `update_plan` call (`src/main/agents/codex/index.ts`). Calls with a `parentCallId` never replace the thread list (`src/renderer/lib/todos.ts`). The plan renders first in the composer `ActivityIndicator` (`src/renderer/components/ActivityIndicator.tsx`).

**Sub-agents.** The provider emits `subagent_updated` with the full `Subagent` state (`src/shared/agent.ts`). The runner keeps sub-agents in memory only. It never folds them into the transcript (`src/main/services/AgentRunner.ts`). Claude maps `task_started`, `task_progress` and `task_notification` (`src/main/agents/claude/mapMessage.ts`). Codex maps `subAgentActivity` and `collabAgentToolCall` items plus child thread notifications (`src/main/agents/codex/subagents.ts`). Both implement `stopSubagent`. Claude calls the SDK `stopTask` (`src/main/agents/claude/index.ts`). Codex interrupts the child turn (`src/main/agents/codex/index.ts`). Muse maps MSP `subagent` items (`src/main/agents/muse/subagents.ts`). It stops one with `subagent/stop` (`src/main/agents/muse/index.ts`). The child session sends no frames on the parent connection. A Muse row therefore has no tool calls of its own.

**Background tasks.** A `BackgroundTask` is work that outlives its tool call and its turn (`src/shared/agent.ts`). The provider exposes a `changes` stream and a `stop` call (`src/main/agents/provider.ts`). The runner keeps the latest set per thread and pushes `thread.backgroundTasks` (`src/main/services/AgentRunner.ts`). The renderer reads `backgroundTasks.list` and calls `backgroundTasks.stop` (`src/shared/contract.ts`). Claude maps the CLI's `background_tasks_changed` snapshot and stops a task with `stopTask` (`src/main/agents/claude/index.ts`). Codex has no change notification for `thread/backgroundTerminals/list`. It polls every 2 seconds once a turn starts a `commandExecution` with a `processId`, until the list is empty and no turn runs. It stops one with `thread/backgroundTerminals/terminate` (`src/main/agents/codex/index.ts`). A command still running at `turn/completed` finishes as "Running in the background", not as failed. A command the agent detaches with `nohup ... &` is not a background terminal, so no provider lists it. Muse has no change notification either. HinaCode follows `item/updated` and `item/completed` for tool calls marked `backgroundStatus.state: "backgrounded"` or `background: true`, and drops the set on `session/closed` or host exit (`src/main/agents/muse/backgroundTasks.ts`). It stops one with `task/stop`. Muse 1.4.12 refuses that for a shell it backgrounded itself, so a lone task falls back to `task/stopAll`. Sub-agents are not background tasks (`src/shared/agent.ts`).

**Turns the agent starts by itself.** The provider may expose a `wakes` stream of `Wake` values (`src/main/agents/provider.ts`). Claude and Muse do (`src/main/agents/claude/index.ts`, `src/main/agents/muse/index.ts`). The runner adopts each wake as a normal turn or calls `discard` (`src/main/services/AgentRunner.ts`). It discards a wake unless the thread is still on the provider that sent it and on the session the wake names.

**Closing a session.** Switching a thread to another agent first calls `closeSession` on the agent it leaves, so nothing of the old agent keeps working in the worktree (`src/main/services/AgentRunner.ts`). If it fails, the thread stays on its agent and the switch reports the error. Claude closes the CLI, which ends its background shells and scheduled wakeups, and drops the resume record, so switching back starts a new session (`src/main/agents/claude/index.ts`). Codex resumes only the session id the runner passes. It interrupts sub-agent turns that outlived their parent's turn, on the app-server of the thread's account, terminates the thread's background terminals and stops polling them (`src/main/agents/codex/index.ts`). Muse sends `session/leave` with `stop`, which cancels the session's turns and background shells, and waits up to 60 seconds for `session/leaveCompleted` to report `released`. Only then does it stop mapping the session to the thread (`src/main/agents/muse/index.ts`).

**Access mode.** Every turn carries an `accessMode` (`src/shared/agent.ts`). Claude maps it to a permission mode (`src/main/agents/claude/access.ts`). Codex maps it to an approval policy and a sandbox (`src/main/agents/codex/access.ts`). Muse maps it to an approval mode (`src/main/agents/muse/index.ts`). Claude and Muse apply a change to the live session in `setAccessMode`. Codex returns void and picks the mode up on the next turn (`src/main/agents/codex/index.ts`). The contract allows that (`src/main/agents/provider.ts`).

**Session copy between accounts.** `copySession` copies transcripts between agent homes so a resumed turn keeps its history (`src/main/agents/provider.ts`). Claude implements it at `src/main/agents/claude/index.ts`. Codex implements it at `src/main/agents/codex/index.ts`. Muse has no agent home and leaves it out. `AccountProviderId` therefore lists only `claude` and `codex` (`src/shared/agent.ts`). The runner refuses an account switch when `copySession` is missing (`src/main/services/AgentRunner.ts`).

**Fork from a turn.** A provider that can fork its session puts a `forkPoint` on `turn_completed`: its session id and its own id for the end of that turn (`src/shared/agent.ts`). The runner stamps it with the agent and account that ran the turn and stores it on the turn's last message, and the fork button shows only there. A fork starts in that account, and switching its account before it sends copies the source session along. A fork's first turn gets the source session as `resumeSessionId` and the checkpoint as `forkAt`. Claude resumes with `forkSession` and `resumeSessionAt` set to the turn's last assistant message uuid (`src/main/agents/claude/index.ts`). Codex calls `thread/fork` with `lastTurnId` (`src/main/agents/codex/index.ts`). Muse has no fork and sends no `forkPoint`. A fork of a thread in a worktree gets its own checkout on `<branch>-fork-xxxxx`, started from the source branch with the source's uncommitted changes, so each checkout keeps a single owner and either thread can be archived or deleted on its own.

## Adding a provider

### Registrations

- Add the provider in `src/main/agents/<name>/index.ts`. Export a `Context.Service` with a `layer`, like `src/main/agents/muse/index.ts`.
- Add the id to `ProviderId` (`src/shared/agent.ts`). Add it to `AccountProviderId` only when the agent reads its login from a home directory (`src/shared/agent.ts`).
- Register it in the `providers` record in `src/main/services/AgentRunner.ts` and in `src/main/services/AgentLogins.ts`.
- Add its layer to the graph in `src/main/app.ts`. Fix the fake providers of integration tests that build those layers.
- Add a migration that widens the `provider` CHECK on `thread` and `automation`. Never edit a shipped migration.
- Add the per-agent keys in `Settings.defaultModel`, `modelPresets`, `defaultAccount` and `defaultAccountName` (`src/shared/domain.ts`).
- Add the icon and label in `ProviderIcon.tsx`, the access hints in `ComposerControls.tsx`, the signed-out hint in account settings, and every new string in `messages/en.json`, `messages/zh-TW.json` and `messages/ja.json`.
- Add a mock for e2e. Claude has `src/main/agents/claude/mock.ts`. Codex tests run a fake server (`src/main/agents/codex/fakeAppServer.mjs`, used at `src/main/agents/codex/index.integration.test.ts`). Muse tests run a fake endpoint (`src/main/agents/muse/fakeEndpoint.ts`, used at `src/main/agents/muse/index.integration.test.ts`).

### Capability checklist

Map each row or leave it out on purpose. Prove each mapped row with a test against a fake server or fixture. Unit tests sit next to the source as `*.test.ts`. Integration tests drive the real process boundary.

- Models. Return `ModelInfo` with efforts, default effort, fast mode and auto mode (`src/shared/agent.ts`). Test the catalog mapping, like `src/main/agents/muse/catalog.test.ts`.
- Account and plan limits. Read the login fresh on each call (`src/main/agents/provider.ts`). Return null limits for an API key. Test signed-in, API key and signed-out states.
- Token usage. Sum the main transcript and every sub-agent transcript. Emit `usage` on `turn_completed` when the agent reports it. Test the transcript reader against fixtures.
- Commands and skills. Return the commands for the thread `cwd` and home with the right trigger, `/` or `$` (`src/shared/agent.ts`). Test user and project scope.
- Streaming text and reasoning. Emit deltas as they arrive. Never wait for the finished item. Test that one native stream yields ordered `text_delta` and `reasoning_delta` events.
- Tool calls and file changes. Pair every `tool_call_started` with a `tool_call_finished`, even after interrupt. Set `parentCallId` for sub-agent calls. Emit `file_changed` only after a successful edit. Test the interrupted case.
- Approvals. Emit `approval_requested` with a stable request id and block until `respondApproval`. Carry a `sessionScope` when the agent supports allow-for-session (`src/shared/agent.ts`). Test allow, allow-for-session and deny.
- Questions. Emit `question_requested` for blocking questions. Emit `questions_posted` only when the turn truly continues. Test both paths and a skipped question.
- Steering. Add the input to the running turn. Fail when no turn runs. Test a steer mid-turn against the fake server.
- Interrupt. End the turn and close any open tool calls. Test that interrupt yields a terminal event.
- Auto-compaction. Emit `compaction_updated` for running, done and failed. Apply `autoCompactTokens` or document why the agent cannot take it. Test a native compaction item end to end.
- Todos and plan. Reuse a name `latestTodos` already folds, or synthesize one like Codex does. Add a fold case in `src/renderer/lib/todos.ts` only for a new shape. Test the fold.
- Sub-agents. Emit full-state `subagent_updated` events. Implement `stopSubagent` when the agent can stop one child. Test start, progress, end and stop, like `src/main/agents/codex/subagents.test.ts`.
- Background tasks. Emit the full set on `backgroundTasks.changes` after every change, including the empty set at session end (`src/main/agents/provider.ts`). Poll when the agent has no change notification. Test appearance, completion and `stop`.
- Wakes. Expose `wakes` only when the agent starts turns by itself. Name the session in `Wake.sessionId`. Make `discard` safe after the turn ended. Test adoption and discard.
- Closing a session. Stop everything the thread's session runs between turns, publish the empty background task set, and forget anything the next turn would resume. Test that its background work ends.
- Access mode. Map every `AccessMode` to the native policy. Apply `setAccessMode` live or return void for next turn. Test the mapping table, like `src/main/agents/codex/access.test.ts`.
- Session copy. Implement `copySession` only with added accounts. Overwrite older copies in the target home. Test a copy then a resume in the new home.
- Fork. Send `forkPoint` on `turn_completed` only when a turn started with `forkAt` set to it can fork the session there. Test that `forkAt` starts a new session, like the `Codex fork` test in `src/main/agents/codex/index.integration.test.ts`.

### Optional fields

Five fields of `AgentProvider` are optional.

- `copySession`. Leave it out without added accounts. The UI then refuses an account switch on a started thread (`src/main/services/AgentRunner.ts`).
- `wakes`. Leave it out when the agent never starts a turn. The runner skips the provider (`src/main/services/AgentRunner.ts`). Nothing changes in the UI.
- `backgroundTasks`. Leave it out when the agent cannot list and stop background work. The list stays empty and the stop call fails with an agent error (`src/main/services/AgentRunner.ts`). The activity section renders nothing.
- `closeSession`. Leave it out when the agent keeps nothing running between turns and resumes only `RunTurnInput.resumeSessionId`. Switching agents then only changes the stored provider.
- `stopSubagent`. Leave it out when the agent cannot stop one child. The stop call fails with an agent error (`src/main/services/AgentRunner.ts`). The sub-agent still shows in the activity tray.

Every other field is required. A provider that cannot do a required thing still returns the empty or void form. Examples follow. `planLimits` returns null. `usage` returns null. `setAccessMode` returns void and applies on the next turn.

## Gaps

- Claude maps every capability in the matrix. It has no `questions_posted` path. Its questions always block the turn.
- Codex and Muse report only used and window tokens, so their context popover shows totals without categories. Claude reports categories only while its session is open, up to 60 seconds after a turn.
- Codex polls background terminals of the parent thread only, not of its sub-agent threads. Codex exposes no `wakes` stream. Codex compaction reports no token counts, so the UI cannot show before and after sizes. Codex applies access mode changes only on the next turn.
- Muse cannot stop one of two or more shells it backgrounded itself, and does not track registry-only tasks such as `monitor`. Muse does not map `session/todoListChanged`. Its todos reach the UI only through `write_todos` tool calls. Muse has no `copySession` and no added accounts.
