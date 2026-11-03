# Mock Claude

Use the mock Claude to see any transcript state in the real app without spending a real turn.

## Steps

1. Start the app with the mock. The variable picks the scenario for any ordinary message:

   ```sh
   HINACODE_USER_DATA=/tmp/kk-mock HINACODE_MOCK_CLAUDE=everything pnpm dev
   ```

   `HINACODE_MOCK_AGENTS=<scenario>` serves Codex, Muse Code and opencode threads from the same mock.

2. Send `/mock-<scenario>` in any Claude thread to run that scenario instead. Type `/mock-` to pick one from the command list.

| Command                 | What it shows                                                                                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/mock-everything`      | `tools`, `tool-states`, `thinking`, `compaction` and `approvals` in one turn.                                                                                                                                                 |
| `/mock-tools`           | Thinking, Grep, Glob, Read, Edit and Write with their file changes, Bash with ANSI output, WebSearch, WebFetch, TodoWrite, Skill, an MCP tool, a sub-agent with nested calls, an artifact card, a table and the context ring. |
| `/mock-tool-states`     | A command that runs for three seconds, long output trimmed to its tail, empty output, a failed command, a failed Read, an image result and an MCP error.                                                                      |
| `/mock-thinking`        | A slow thinking block, then a Markdown reply with a code block.                                                                                                                                                               |
| `/mock-compaction`      | Compaction running, done with token counts, and failed.                                                                                                                                                                       |
| `/mock-approvals`       | Command, patch, domain and MCP tool approvals, then a question. Allow some and deny others, with or without a note, to see both results.                                                                                      |
| `/mock-error`           | A turn that fails with an API error.                                                                                                                                                                                          |
| `/mock-stop`            | A running command and a reply that keeps streaming until you press Stop. The turn ends as Interrupted and the command as failed.                                                                                              |
| `/mock-usage-limit`     | The plan usage limit callout. The next attempt succeeds. `HINACODE_MOCK_RESET_MS=5000` sets a five-second reset.                                                                                                              |
| `/mock-org-spend-limit` | The organization spend limit callout.                                                                                                                                                                                         |
| `/mock-todos`           | Three tasks. The next ordinary message completes them, so launch with `HINACODE_MOCK_CLAUDE=todos`.                                                                                                                           |
| `/mock-markdown`        | Every Markdown construct the transcript renders, from `src/main/agents/claude/fixtures/markdown.md`.                                                                                                                          |
| `/mock-stream`          | Thinking, six reads and a long reply, streamed quickly. The perf scripts use it.                                                                                                                                              |
| `/mock-activity`        | Background shells, a sub-agent and tasks, held until Stop.                                                                                                                                                                    |
| `/mock-long-turn`       | 400 steps, then text that streams until Stop.                                                                                                                                                                                 |
| `/mock-subagents`       | Six sub-agents in every status, updating every two seconds.                                                                                                                                                                   |
| `/mock-artifacts`       | Publishes an artifact named after the prompt through the real MCP server.                                                                                                                                                     |

Stop ends every scenario as Interrupted, not only `/mock-stop`.

## Adding a scenario

Add its name and description to `mockScenarioDescriptions` in `src/main/agents/claude/mock.ts`. The command list comes from that table. Write the turn as `MockStep`s in `src/main/agents/claude/fixtures/transcript.ts`, using the Agent SDK message builders in `fixtures/sdk.ts`, and register it in `playedSteps`. `play.ts` runs the steps through the real `mapMessage`, so a fixture renders the way a real turn would.

## If it goes wrong

- A `/mock-` message gets the default scenario. The command must start the message and name a scenario from the table.
- The app refuses to start with `HINACODE_MOCK_CLAUDE must be one of ...`. The variable names a scenario that no longer exists.
