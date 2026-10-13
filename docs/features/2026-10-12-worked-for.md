# Worked for

Status: Shipped
Date: 2026-10-12

## Problem

Developers returning to a finished response have to scroll through its reasoning and tools to reach the answer. They cannot see how long that response took.

## User flow

While the agent runs, its activity stays visible. When an assistant response completes, a quiet `Worked for 08:05` row appears above the answer. Select the row to expand its reasoning, tool calls, file changes, and progress text. Enter and Space toggle the same disclosure. Tool input, output, and subagent navigation remain inspectable inside it.

Text-only responses show the duration without a disclosure. Questions and attachments stay visible. Find in thread opens work containing the selected match, including grouped commands. Closing Find keeps that work open until the reader closes its disclosure.

## Design

`Message.createdAt` and `Message.completedAt` already persist in SQLite. Their difference supplies elapsed wall time, including approval waits. Each steer ends one assistant response and begins another, so each response segment has its own duration. This does not claim to time a whole provider turn across steers.

The renderer derives an `AssistantPresentation` union. `inline` holds indexed visible parts for a running response. `completed` adds `durationMs`, `work`, and `reply`. Original part indices preserve React keys. Work includes the parts through the last reasoning, top-level tool, or file change. Questions and attachments stay in the reply regardless of their position. Nested subagent calls remain in the subagent view. Synthetic subagent transcripts keep their existing rendering.

No migration, RPC method, provider event, or new trust boundary is needed. Invalid or reversed timestamps retain the existing inline rendering. Empty closed messages stay hidden. Duration uses `mm:ss`, or `h:mm:ss` above an hour. The existing Base UI collapsible supplies keyboard support and disclosure state. Theme tokens support both themes; chevron feedback respects reduced motion.

## Out of scope

Live timers, provider CPU time, and timing a whole run across steers. A response recovered after an unclean shutdown uses the existing completion timestamp, which can include time the app was closed.

## Verification

Pure tests cover the presentation split, completion timing, questions, nested calls, and duration formatting. Electron acceptance scenarios exercise completion, keyboard disclosure, final-answer visibility, find, restart, and both themes. The existing streaming scenarios also check that finished text, tool output, and errors survive the completion boundary.

An isolated native Electron instance on macOS ran a real Codex command. Its saved timestamps span 15.036 seconds, and the row reads `Worked for 00:15`. Keyboard expansion reveals the progress and command; the output remains inspectable. Restarting the same profile preserves the duration and renders `已工作 00:15` in Traditional Chinese. Collapsed and expanded screenshots in both themes are under `.context/shots/worked-for-*`. The Linux Xvfb helper is unavailable on this host, so the instance used its own data directory and CDP port with native Electron.

Live verification covers Codex. Claude, steering, and approval waits use the same tested renderer helper, but were not driven with paid agent turns. Recovery after an unclean shutdown retains the timestamp limitation described above.

Checkpoints are the presentation tests, renderer typecheck and lint, the Electron acceptance suite, then a real agent response with screenshots. Required final checks are `pnpm typecheck`, `pnpm lint`, and `pnpm test`.

Typecheck and lint pass. The unit and integration suite passes with `--maxWorkers=2` and a canonical temporary directory outside the repository. The full Electron run passes with `--workers=2 --retries=1` and the canonical macOS temporary path. An existing panel-resize scenario needs its retry; the Worked for and streaming scenarios pass on their first attempts.
