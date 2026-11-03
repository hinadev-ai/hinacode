# A private tmp folder per thread

## Problem

Agents and the tools they run (test suites, copied databases, isolated app instances, TLC, Chromium profiles) write into the shared `/tmp`. On a Linux box where `/tmp` is a small tmpfs, a few busy threads fill it, and every other thread then fails with `disk I/O error` or `EDQUOT`. Archiving a thread removes its scratch folder but leaves everything it put in `/tmp`, and nothing records which `/tmp` entry came from which thread, so cleaning up by guessing would delete other threads' work.

## Design

Borrow systemd's `PrivateTmp`. Each thread gets its own temp folder before its agent starts, and the agent process is spawned with `TMPDIR`, `TMP` and `TEMP` pointing at it. Everything the agent runs inherits the variables, so `os.tmpdir()`, `mktemp`, Python's `tempfile` and Chromium all write there.

- The folder is `<os.tmpdir()>/hc-<6 hex of a hash of the data dir>/<first 8 characters of the thread id>`. It is based on `os.tmpdir()`, so a `TMPDIR` the user set for HinaCode still holds.
- Each data dir gets its own root. A copy of the real database, such as a verify-hinacode instance or a perf harness, has the same thread ids, so a root shared by thread id alone would let that copy delete the real app's folder while its agent uses it.
- The root is created with mode `0700`, then checked with `lstat`. It must be a real directory, owned by this user and not writable by group or others (Windows skips the owner and mode checks). Otherwise another user on a shared `/tmp` could pre-create it, or a symlink, and catch the agent's files. When the check fails, HinaCode logs a warning and spawns the agent with the inherited temp directory, rather than failing the turn.
- The path stays short on purpose. A Unix domain socket path must fit in 108 bytes, and tools put sockets under `TMPDIR`. The scratch folder's path is around 100 characters, so a `TMPDIR` inside it broke Chromium and other socket users.
- `Scratch` owns both folders, so one service owns a thread's disk state. `ensureTmp` creates the tmp folder when `AgentRunner` builds a session, and `remove` deletes both folders on archive and delete, in the background. A missing folder is not an error.
- Unarchiving needs nothing. The folder is created again on the next spawn.

## Providers

| Provider       | Covered | How                                                                                                                                                                                 |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code    | Yes     | One CLI process per thread, spawned with the variables.                                                                                                                             |
| Codex          | Yes     | One app-server is shared across threads, so the variables go into the thread's `shell_environment_policy.set` config, which Codex applies to every command it runs for that thread. |
| Muse Code      | No      | One host serves every thread, and MSP has no per-session environment.                                                                                                               |
| opencode (ACP) | No      | One agent process serves every thread, and ACP's `session/new` has no environment.                                                                                                  |

Terminals keep the shared `/tmp`. They are the user's shells, not the agent's.

## Out of scope

- A startup sweep of `hc-*` folders whose thread is gone. Archive and delete already remove them. A folder a crash left half deleted keeps its `.removing` suffix, and the next start deletes it from this data dir's root only, the same way the scratch root does.
- Cleaning what threads wrote to `/tmp` before this change.

## Verify

Start a Claude thread in an isolated instance, ask it to print `os.tmpdir()` and create a file there, then archive the thread and check that the thread's folder under `<os.tmpdir()>/hc-<hash>/` is gone.
