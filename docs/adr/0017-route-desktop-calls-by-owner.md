# 0017. The desktop routes each call by who owns its ids

Status: Accepted
Date: 2026-10-15

## Context

ADR 0016 pins every thread to the cloud whose project it was created in. The desktop now has to drive those clouds next to its own threads. kkcode's job is to show which agent needs a human, so a thread waiting on a cloud cannot sit behind a mode switch.

There were three ways to get there:

1. **An active environment.** One environment at a time, switched with a reload. It is the cheapest option, but it hides every other environment's attention.
2. **T3 Code's approach.** Every client reference becomes an `(environmentId, id)` pair. That makes every store, atom and call site environment-aware.
3. **Orca's approach.** A merged view plus a separate "Active Server" for some actions, which leaves two notions of "current".

## Decision

The window shows every environment at once and has no active environment. Thread, project, worktree, terminal and automation ids are UUIDs, so main routes each renderer call by which environment owns the id in its payload. It learns ownership from the answers and pushes each cloud sends.

`src/main/environments/routes.ts` gives every rpc method one of four routes: `client`, `all`, `owner` or `named`. The table is a `Record<RpcMethod, Route>`, so a new method does not compile until it picks one. Only `named` methods take an `environment` from the renderer, and the UI already asks the user for one in exactly those places: settings, adding a project, models and accounts.

## Consequences

- The renderer stays almost unaware of environments. Stores keyed by thread id keep working, because ids never collide across machines.
- Roots are paths, not ids. A cloud project at the same path as a local one takes the `git.*` and `fs.*` calls for that path.
- The owner index lives in memory and is rebuilt from lists at boot and on every reconnect. An id nobody has claimed belongs to this desktop.
- Merged lists answer from a cloud's last reply while it is offline, so its projects and threads stay in the sidebar but can be stale.
- Revisit when a thread needs to move between machines, or when the same repository on two machines should be one project. Either one turns ownership from a lookup into data the renderer must carry.
