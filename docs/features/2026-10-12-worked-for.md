# Worked for

Status: Shipped
Date: 2026-10-12

## Problem

Developers returning to a finished response cannot see how long it took. Its tool activity also crowds out the answer. A long run of reads, searches, and commands pushes the agent's progress text and reply apart. Tool output is supporting information, so it should be one step away rather than in the reading path.

## User flow

While the agent runs, its activity stays visible. When an assistant response completes, a quiet `Worked for 08:05` row appears above it, and the response's reasoning, tool calls, and file changes fold away. Progress text, questions, attachments, and the answer stay visible in their original order. Selecting the row, or pressing Enter or Space on it, shows the activity again in place.

Back-to-back tool calls of any kind fold into one line that names what they did, such as `Ran 2 commands, read 2 files, and searched once`. The line opens into a list capped at 24rem that scrolls, and each row opens into its input and output. Sub-agent calls never fold, because their row opens the sub-agent's own view.

Text-only responses show the elapsed time with no disclosure. Find in thread searches the hidden activity too. A match there opens the Worked for row and the tool group that holds it. Closing Find leaves them open until the reader closes them.

## Design

`Message.createdAt` and `Message.completedAt` already persist in SQLite. Their difference supplies elapsed wall time, including approval waits. Each steer ends one assistant response and begins another, so each response segment has its own duration. This does not claim to time a whole provider turn across steers.

The renderer derives an `AssistantPresentation` union. Both variants hold indexed visible `parts`. `completed` adds `durationMs`; `inline` has no elapsed-time row. Original part indices preserve React keys, tool grouping, and find targets. `isActivity` marks reasoning, tool calls, and file changes. A completed response filters those out until its row is expanded, so activity keeps its exact position between progress messages when shown. The expanded state lives in the message's component, like every other disclosure in the transcript, and resets when the list virtualizes the message away. Nested subagent calls remain in the subagent view. Synthetic subagent transcripts keep their existing rendering.

No migration, RPC method, provider event, or new trust boundary is needed. Invalid or reversed timestamps retain the existing inline rendering. Empty closed messages stay hidden. Duration uses `mm:ss`, or `h:mm:ss` above an hour. Theme tokens support both themes. The row's chevron turns with the disclosure and holds still under reduced motion.

## Out of scope

Live timers, provider CPU time, and timing a whole run across steers. A response recovered after an unclean shutdown uses the existing completion timestamp, which can include time the app was closed.

## Verification

Pure tests cover original part order, which parts count as activity, tool-call folding, per-kind counts, completion timing, and duration formatting. Electron acceptance scenarios exercise the hidden-by-default activity, keyboard toggling, tool output, Find revealing a hidden tool call, restart, and both themes. The streaming scenarios check that finished text, tool output, and errors survive the completion boundary.

A Linux Xvfb run of isolated Electron profiles seeded one completed response with eleven tool calls, built once from the parent commit and once from this change. Screenshots in `.context/shots/tools-*` show the before transcript, the hidden default, the expanded activity with two folded groups, the capped list scrolling a 120-line output, and the light theme.

Checkpoints are the presentation tests, renderer typecheck and lint, the Electron acceptance suite, then the screenshots. Required final checks are `pnpm typecheck`, `pnpm lint`, and `pnpm test`.
