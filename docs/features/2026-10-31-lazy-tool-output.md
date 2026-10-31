# Lazy tool output

Status: Shipped
Date: 2026-10-31

## Problem

Tool outputs are most of a transcript. In one real 110 MB database, tool calls hold 74 MB of the 80 MB message table, and Bash output alone holds 51 MB, up to 497 KB in a single call. Opening a thread sent every output in full: main encoded it, Electron cloned it to the renderer, the renderer decoded it, and the store kept it for each of the 8 cached histories. Live `tool_call_finished` pushes and the `message.updated` that closes a turn carried the same outputs again. The developer reads almost none of it: tool calls start collapsed, and an expanded Bash call shows about 18 lines before it scrolls.

## User flow

1. The developer opens a thread. It loads with every long output cut down to its last lines.
2. They expand a tool call. A long output shows its tail, which is where a command's result and errors are, with **Show full output (31.8 kB)** above it.
3. They press the button, by mouse or with Tab and Enter. The full output replaces the preview. Collapsing the call lets it go again.

## Design

`shared/compactTranscript.ts` already shrinks transcripts for phones, so the preview lives next to it.

- `previewMessage` replaces a tool call's output when it is a string longer than `TOOL_OUTPUT_PREVIEW_CHARS` (4,096). The preview is the last 4,096 characters, starting at the first line break when one falls in the first half, so a line and its ANSI codes are not cut in two. The part gets `fullOutputBytes`, the UTF-8 size of the full output, an optional field on the `tool_call` part in `domain.ts`.
- `previewPush` does the same to `message.created`, `message.updated` and `tool_call_finished`. The event gets the same optional field, and `foldEvent` copies it to the part.
- Only string outputs are cut. They are 99% of the bytes (Bash and Read). Structured outputs, such as MCP results and the content blocks that carry a sub-agent's report, stay whole, so the views that parse them need no change.
- `threads.transcript` applies `previewMessage` unless the caller asked for `compact`, and `AgentRunner.publishTranscript` applies `previewPush` to every push. Both are the points where a transcript leaves the runner, so desktop windows, cloud environments and phones all get previews. The runner's in-memory turn and the database keep full outputs.
- `threads.toolOutput { threadId, callId }` returns one full output. It reads the running turn first, because the database lags it by up to 500 ms, and otherwise selects only that part's output with `json_each`, so it does not decode the whole thread. It is routed by thread like `threads.transcript`.
- `ToolCallDetails` shows the button when `fullOutputBytes` is set and keeps the loaded output in component state. Messages give the part's thread through `PartThread`, so side chats and sub-agent views ask the right thread.

### Why 4,096 characters

An expanded Bash call scrolls after about 18 lines, about 2 KB of typical output, and a call inside a group scrolls after 24. A 4 KB tail fills that box about twice, which keeps a test run's summary or a stack trace together. In the largest thread of the database above, these limits leave this much in the reply:

| Limit | Outputs cut | Reply (JSON) | Reply (structured clone) |
| ----- | ----------: | -----------: | -----------------------: |
| none  |           0 |       9.5 MB |                  13.4 MB |
| 16 KB |         135 |       6.9 MB |                   8.8 MB |
| 8 KB  |         268 |       5.1 MB |                   6.3 MB |
| 4 KB  |         374 |       3.8 MB |                   4.5 MB |
| 2 KB  |         455 |       2.9 MB |                   3.3 MB |

Going down to 2 KB saves another 0.9 MB but leaves less than one box of scrollback, so the developer would press the button for almost every output they expand. The rest of the reply is mostly tool inputs: 1.4 MB, of which Codex's raw `commandExecution` items are 1.2 MB.

### Measured

`threads.transcript` for that thread, 1,022 tool calls in 56 messages, median of 11 runs:

|                                            |      Before |       After |
| ------------------------------------------ | ----------: | ----------: |
| JSON size                                  |      9.5 MB |      3.8 MB |
| Structured clone size                      |     13.4 MB |      4.5 MB |
| Preview, encode, clone and renderer decode | 25 to 44 ms | 17 to 21 ms |

Loading the rows in main is unchanged, at 50 to 100 ms, because SQLite still returns and main still parses whole messages.

## Out of scope

- Paging messages. The phone pages already; the desktop still loads every message.
- Cutting outputs in SQL, which would also save the load in main.
- Shrinking tool inputs, such as the Codex items stored whole.
- Keeping a loaded full output after its call collapses.

## Verification

`ipc.integration.test.ts` runs a turn with a 19 KB Bash output and checks that `threads.transcript` and the `tool_call_finished` push carry the tail with `fullOutputBytes`, that `threads.toolOutput` returns the full output, and that an unknown call fails with `NotFoundError`. `compactTranscript.test.ts` covers the line break, UTF-8 sizes and outputs that stay whole; `foldEvent.test.ts` covers the folded field.

With `verify-hinacode`, insert a message with a long Bash output into the instance's database, open the thread, expand the call, check the button and its size, press it, and check that the output now starts at its first line.
