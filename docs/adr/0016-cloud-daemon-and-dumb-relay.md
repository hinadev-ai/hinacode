# 0016. A cloud owns its threads, the server only relays

Status: Accepted
Date: 2026-10-14

## Context

ADR 0001 put everything in the Electron main process because kkcode was local only, and called out that remote access would need a new transport. Remote mode added that transport for phones, but the agents still die with the desktop app. Running agents on an always-on home server needs the layer graph without a window, and reaching that server from anywhere needs a rendezvous point. The open question was where thread state lives once there are three roles (cloud, server, client): one central database the server owns, with clouds as executors, or one database per cloud, with the server forwarding.

A central database makes one global thread list trivial, but it splits Threads, Worktrees, the runner, the PR watcher and automations across a network boundary, puts transcripts and worktree metadata on a machine that never runs the code, and makes every cloud useless while the server is down. Orca's environments and T3 Code's environments both keep each machine's state on that machine and treat the middle as connection plumbing.

## Decision

Each cloud keeps its own SQLite file, projects, worktrees and agent processes under its own `KKCODE_USER_DATA`. The server is a dumb relay: it tracks which clouds are paired and present, and forwards the existing remote frames between a client and one cloud without decoding them. A thread is pinned to the cloud whose project it was created in and never moves. See `docs/features/2026-10-14-remote-clouds.md`.

## Consequences

- Slice 1 needs no new protocol: a cloud is the existing layer graph serving the remote WebSocket, so the current phone app works against a home server unchanged.
- A cloud keeps working over Tailscale or LAN when no server exists or the server is down. The server is an address book and a pipe, never a dependency for running a turn.
- Nothing user-owned is stored centrally, which keeps a self-hosted server cheap to run and boring to breach. In slice 3 the server can still read forwarded traffic under TLS, so pinned-key end-to-end encryption remains the named hardening step if a hosted server ever ships.
- The client's global view is a merge of per-cloud subscriptions, so an offline cloud shows stale state honestly instead of a wrong fresh one.
- The same repository on two clouds is two project rows in two databases. Git stays the sync mechanism, and no settings or secret sync is implied by this decision.
- Revisit if a thread ever needs to move between machines mid-flight, or if several people share one cloud and need per-user access. Both would push state and identity toward the server.
