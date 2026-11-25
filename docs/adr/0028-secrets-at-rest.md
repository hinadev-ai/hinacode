# 0028. Secrets at rest

Status: Accepted
Date: 2026-11-25

## Context

HinaCode keeps API keys, relay credentials, pairing tokens and values agents ask for with `request_secret`. The agents it runs execute code as the same OS user, and a prompt injection can turn any of them into a reader of that user's files. On 2026-11-24 a widely shared report showed another agent harness storing such keys as plaintext files, caching them in memory without expiry, and writing V8 heap snapshots that contain them. People now pick a harness partly on this.

We sealed secrets with Electron `safeStorage`, but we counted Linux's `basic_text` backend, whose key is hardcoded in Chromium, as sealed. `hinacode serve` stored plaintext and said so only in `docs/arch.md`. `request_secret` values sat in plaintext files that every thread could read. See `docs/features/2026-11-25-secret-storage-hardening.md`.

What each mechanism actually protects against, on the same machine:

- macOS Keychain: the item's access list names the signed app, so another process asking for it gets a prompt. This is the only store here that stands between an agent and the key.
- Windows DPAPI: any process running as the user can decrypt. It protects a copied disk or backup, not the running session.
- Linux Secret Service (libsecret, KWallet): any process on the user's session bus can read an unlocked item. It protects data at rest only.
- POSIX file modes: they keep other users out. They do nothing against processes of the same user, and nothing on Windows, where Node ignores them.

## Decision

1. **Name the backend honestly.** `Keyring` carries its backend: `keychain`, `dpapi`, `libsecret`, `kwallet`, or `none`. On Linux, `basic_text` and `unknown` count as `none`. Only a real backend can seal. Settings shows the backend, and shows a warning that stays on the page when it is `none`.
2. **Seal what was left behind.** At startup `Secrets` seals every plaintext row when a real keyring is present. With `none`, it stores rows sealed under `basic_text` as plaintext, which is what they were, so a keyring installed later seals them.
3. **The cloud stores plaintext, and says so.** `hinacode serve` runs on headless machines, where a Secret Service is usually missing or locked, and where it would add no isolation from the agents it runs. A key file or an environment variable would sit next to the data, readable by the same agents. So the daemon keeps plaintext in `hinacode.sqlite`, prints a warning on every start, and its Settings show the warning. We add no native dependency and no extra process.
4. **Agent secrets live sealed and reach disk only during a turn.** `request_secret` stores the value in `Secrets` under `thread.<id>.<NAME>`. The runner writes the files at the start of each turn of that thread and deletes them when the turn ends, fails or is stopped. `Scratch` deletes leftovers when it starts. Archiving or deleting the thread clears the rows.
5. **Agents are told to stay out where the provider can enforce it.** Each session gets a list of paths it may not read: the database files, the Chromium profile, the tiny VM's Chromium profile, and every other thread's scratch folder. Claude gets `Read(...)` deny rules in its settings file. Codex gets a permission profile with `deny` entries that its sandbox enforces. Muse, opencode and pi get nothing yet (see `docs/agent-providers.md`).
6. **Database files are 0600** on POSIX, set before SQLite opens them.

### Invariants

Future code, including diagnostics, must keep these:

- **No plaintext secret cache with an unbounded lifetime.** Read a secret from `Secrets` where it is used and drop it. Exceptions are the credentials the process checks on every request: the remote pairing token, the per-thread MCP credentials, and the app server's client key. They live in memory for the process lifetime and are never written anywhere else.
- **No diagnostic dumps that can contain secrets.** The shipped app and the daemon never write heap snapshots, never install a signal handler that writes one, never pass `--heapsnapshot-signal` or `--heapsnapshot-near-heap-limit`, and never call `crashReporter.start`. Profiling scripts in `scripts/perf/` may take heap snapshots only of an isolated instance with its own `HINACODE_USER_DATA`, and write them under `.context/`.
- **A secret value never enters an event, a message, a log line, an rpc response to the renderer, or a tool result.** `request_secret` returns a path.

## Consequences

- Linux users without a Secret Service see the truth in Settings, and their secrets are sealed once they install one and restart.
- A cloud machine is as safe as its user account. That is now stated instead of implied.
- A `request_secret` value is on disk only while a turn of its thread runs. A long background command started in a turn can still read it, because it read the file while the file existed.
- The deny rules are a boundary only for Codex's sandbox. Claude's rules stop its file tools and a plain `cat` of the path, but a shell command that globs or runs another interpreter still reads the file unless the user turns on Claude Code's own sandbox. The deny list a session gets is fixed when it starts, so a thread created later is not in it.
- On Linux and Windows, an agent that can read the database can also ask the keyring for the key. The deny rules and the turn-scoped files narrow that window; nothing short of a separate OS user closes it.
- Revisit when we resolve secrets from an external manager per use (1Password `op://` and the like), which would keep values out of the database entirely, or when a provider gains a sandbox we can configure.
