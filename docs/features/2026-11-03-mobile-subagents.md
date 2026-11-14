# Sub-agents on the phone

Status: Shipped
Date: 2026-11-03

## Problem

When a turn fans out to sub-agents, the phone showed each `Agent` call as a plain row. The developer could not open one, see what it was asked, what it ran, why it failed, or stop the one that went off track. They had to walk back to the desk to find out, which is the thing the phone app exists to avoid.

## User flow

1. In a thread's Chat tab, each `Agent` call is a row with the sub-agent's status (a still violet dot while it runs, a check when it completed, a red warning when it failed, a stop mark when it was stopped) and a chevron.
2. While any sub-agent runs, a tray above the composer sums up the batch, as the desktop's activity line does: a meter with one segment per sub-agent, `2 of 6 running`, how many failed, and the newest running one. Tapping it expands a list of the batch with each one's latest progress line and `tools · tokens · elapsed`.
3. Tapping a row in the transcript or the tray pushes the sub-agent's screen: its task, a status pill, the provider, live stats, its prompt (long prompts fold after six lines), the tool calls it made, and its report rendered as Markdown. A failed sub-agent shows why in a red notice above the prompt.
4. While it runs, the screen follows each new tool call, and a Stop sub-agent button stops that sub-agent alone. The turn and the other sub-agents keep going.
5. A nested sub-agent's `Agent` call opens another sub-agent screen. Back returns to the parent, as the native stack does.
6. If the connection drops, the screen keeps what it showed under the reconnecting banner and reads the sub-agent again on reconnect.

## Design

- **Data.** The phone reads the thread transcript with `compact: true`, which drops a sub-agent's own calls and every tool call's input and output except a one-line summary. So the sub-agent screen does not reuse the paged transcript. A new `subagents.transcript { threadId, callId }` rpc returns `{ spawn, calls, startedAt }`: the full spawning `Agent` call (its prompt and report) and the sub-agent's own calls, compacted like the phone's transcript. It runs `findSubagentWork` on the server, so it finds the call however far back it is, with no paging on the phone. `compact` defaults to `true` for the phone; the desktop sends `compact: false` and gets the calls with full inputs and outputs previewed like its transcript, to fill in the calls its transcript drops from completed messages.
- **Live updates.** `subagents.list` and the `thread.subagents` push already reached the phone. `stores/subagents.ts` keeps the list per thread, replaces it on each push, and reloads it after a reconnect. The sub-agent screen reads `subagents.transcript` again whenever its sub-agent's status, tool count, last tool or summary changes, which is every step the provider reports. No per-event merging.
- **Stop.** The screen calls the existing `subagents.stop`.
- **Shared code.** `findSubagentWork`, `inputField`, `subagentReport`, `statusOfCall` and `inFlight` moved from the renderer to `src/shared/subagents.ts`, so the desktop, the server and the phone run the same code. `compactSubagentWork`, `previewSubagentWork` and `mergeSubagentWork` live there, `isOwnPart` lives in `src/shared/compactTranscript.ts`, and `outputText` lives in `src/shared/agent.ts`.
- **Rendering.** The screen reuses the chat's `AssistantMessage` with activity unfolded, so tool rows and the Markdown report look the same as in the thread.

## Out of scope

- A separate Agents tab. The Chat tab already has four segments on a 402 pt screen, and the transcript rows plus the tray cover the same list.
- Steering one sub-agent, and Codex child-thread approvals, as on the desktop.
- Sub-agents after a server restart. The server keeps them in memory, so their spawning calls stay as they were last recorded.

## Verification

Run the mock server with the `subagents` scenario (`HINACODE_MOCK_AGENTS=subagents`), send a prompt from the phone, and on iOS and Android:

- open the running sub-agent and watch tool calls arrive and the elapsed time count;
- stop it and see it turn Stopped while the turn keeps running;
- open the completed one and read its report, and the failed one and see its reason;
- restart the server while a sub-agent screen is open and see the banner, then the reloaded screen.
