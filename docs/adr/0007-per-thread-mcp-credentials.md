# 0007. Per-thread MCP credentials

Status: Accepted
Date: 2026-10-11

## Context

Issue #7: the built-in MCP server used one app-wide token, chose the thread from a `?thread=` URL parameter, and handed the Claude CLI a URL that showed up in its process arguments. Any agent could act as any thread.

## Decision

- Each thread gets a `<threadId>.<secret>` bearer credential in the `Authorization` header.
- The server derives the thread from the credential alone, compares the secret with `timingSafeEqual`, and rejects deleted threads.
- Claude reaches the server through an in-process forwarder, so the CLI never sees the credential. Codex receives it as a header in its thread config, over stdin.
- The server listens on 127.0.0.1 only.

## Consequences

- An agent can only link PRs or review changes for its own thread.
- Credentials last until restart or thread deletion, with no per-turn rotation.
- This doesn't isolate threads from a compromised process running as the same user. That's out of scope.
