# 0002. Effect v4 services in the main process

Status: Accepted
Date: 2026-10-11

## Context

The main process juggles child processes, streams, timeouts, interruption, locks and resource cleanup on quit. Promise code for that gets fragile.

## Decision

The main process is one Effect 4 `ManagedRuntime` built from a layer graph. Each service is a `Context.Service` with a `make` effect and a `layer` export. Effect v3 satellite packages are excluded.

## Consequences

- Interruption, scoped cleanup and typed errors come for free. For example, Stop cancels a Codex startup, and quit disposes running turns within 5 s.
- Contributors need to read Effect. The renderer stays plain React and only uses `@effect/atom-react` to load data.
- Effect is about 4 MB of the renderer bundle, because the renderer shares its schemas.
