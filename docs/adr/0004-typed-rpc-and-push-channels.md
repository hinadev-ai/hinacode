# 0004. One schema-typed rpc channel and one push channel

Status: Accepted
Date: 2026-10-11

## Context

Effect RPC has no Electron IPC transport, and a channel per feature spreads validation across files.

## Decision

`src/shared/contract.ts` maps each method name to a request and a response schema. The renderer calls `rpc` through `ipcRenderer.invoke`. Main decodes the request, runs the handler as an Effect, and returns either the encoded result or `{ error: { tag, message } }`. Main pushes updates on a single `event` channel, whose payload is also a schema union. Channel names live in `src/shared/channels.ts`, so the CJS preload doesn't import Effect.

## Consequences

- Adding a feature means adding one line to the contract plus one handler.
- Every message that crosses the process boundary is validated, and only the top-level app frame may call `rpc`.
- Pushes are fire-and-forget. A view that needs consistency loads a snapshot that includes a sequence number, then applies only the pushes after it ([0005](0005-agent-event-stream-not-event-sourcing.md)).
