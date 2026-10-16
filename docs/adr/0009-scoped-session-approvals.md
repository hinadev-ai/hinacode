# 0009. "Allow for session" covers only what the card showed

Status: Accepted
Date: 2026-10-11

## Context

Issue #11: "Allow for session" on one `git status` approved every later Bash command.

## Decision

A session grant is a `SessionScope`, `{ tool, kind, value }`:

- `command`: the exact Bash command.
- `path`: the exact file path for file tools.
- `domain`: the domain for WebFetch.
- `tool`: every call of the tool. This applies only to tools with no narrower key, such as WebSearch and MCP tools. The card warns before the user grants it.

Codex asks before each MCP tool call through `mcpServer/elicitation/request`, which hinacode shows as an approval.

## Consequences

Users click "allow" more often for varied commands. That's the right trade, because a grant now means what it says.
