# Secret storage hardening

Status: Building
Date: 2026-11-25

## Problem

Developers paste API keys into HinaCode: the Linear key, magpie's gateway key, cloud tokens, and values an agent asks for with `request_secret`. They pick a harness partly on whether those keys end up in the OS keychain. Ours mostly did, with five gaps:

1. On Linux, Electron's `safeStorage` falls back to the `basic_text` backend, which encrypts with a key hardcoded in Chromium. We counted that as sealed. When no keyring existed at all, we stored plaintext and only logged a warning nobody reads.
2. `hinacode serve` has no keyring, so the cloud stores every secret as plaintext. Nothing said so outside `docs/arch.md`.
3. `request_secret` wrote the value to `<scratch>/secrets/<NAME>` and kept it until the thread was archived. Any agent in any thread, running as the same user, could read every other thread's secrets.
4. Agents were not told to stay out of the data directory: `hinacode.sqlite`, the Chromium profile, and other threads' scratch folders.
5. `hinacode.sqlite`, `-wal` and `-shm` were created 0644. Only the data directory was 0700.

## User flow

1. The developer opens Settings, Integrations. Above the Linear key, a line names where secrets are kept on that machine: macOS Keychain, Windows DPAPI, Secret Service (libsecret), KWallet, or "no OS keyring".
2. With no keyring, the line becomes a warning that stays: secrets on this machine are stored as plaintext, with the reason and what to install. A cloud machine always shows it.
3. When a keyring appears later, for example after installing `gnome-keyring`, the next start seals every plaintext row. The warning goes away.
4. An agent calls `request_secret`. The card in the thread looks the same. The agent gets a path, reads the file inside its command, and the file disappears when the turn ends or is stopped. The next turn in that thread finds the file at the same path again.
5. `hinacode serve` prints a warning on startup that its secrets are plaintext, with the database path.

## Design

### Honest keyring backend

`Keyring` gains a `backend`: `keychain`, `dpapi`, `libsecret`, `kwallet`, or `none`. Only a real backend has `seal`. The desktop entry derives the backend from `safeStorage.isEncryptionAvailable()` and, on Linux, `safeStorage.getSelectedStorageBackend()`, which maps `basic_text` and `unknown` to `none`. The daemon and `hinacode pair` pass `noKeyring`.

When the `Secrets` layer starts, it walks every `secret.*` row once:

- With a real backend, it seals every plaintext row.
- With `none`, it opens rows sealed under `basic_text` and stores them as plaintext, so that a real keyring can seal them later. Rows that do not open stay as they are and read as unset, as before.

A new rpc, `secrets.storage`, routed to the named environment like `secrets.has`, returns the backend. `IntegrationSettings` shows it above the secret fields.

### Cloud daemon

`hinacode serve` keeps plaintext secrets. It prints a warning on startup and documents it. [ADR 0028](../adr/0028-secrets-at-rest.md) records why we add no Secret Service client or key file.

### `request_secret`

- `respondSecret` stores the value with `Secrets.set("thread.<id>.<NAME>")`, then writes the file.
- At the start of every turn of the thread, including a turn the agent wakes into, the runner writes each of the thread's secrets to `<scratch>/secrets/<NAME>`, 0600 in a 0700 folder. `finish` removes the folder, and `finish` runs when a turn completes, fails, or is stopped.
- `Scratch` deletes every leftover `secrets/` folder when it starts, which covers a crash or a killed app.
- Archiving or deleting a thread clears its `thread.<id>.` rows, the same lifetime the files had before.
- The value travels renderer → `secrets.respond` → main → `Secrets` and the file. It never enters an event, a message, a log line or the tool result. The tool result names the path only.

Settle needs no new step, because the files are already gone when a turn ends, before any settle.

### Agents and the data directory

`Scratch.unreadableBy(threadId)` lists what a thread's agent may not read: `hinacode.sqlite*`, the Chromium profile, the tiny VM's Chromium profile, and every other thread's scratch folder. The runner computes it with the rest of the environment when a turn starts and passes it as `RunTurnInput.unreadablePaths`. The thread's own scratch folder, including its `secrets/`, stays readable, because the agent reads its secret with `cat '<path>'` and Claude's deny rules also stop a plain `cat` of a denied path.

- Claude and magpie: `Read(//<path>)` deny rules in the settings file HinaCode writes for each session. They stop Read, Grep, Glob, Edit and Write in every permission mode, and a plain `cat` of the path. A shell command that globs or runs another interpreter still reads the file unless the user turns on Claude Code's sandbox.
- Codex in supervised and auto mode: a `hinacode` permission profile in the `thread/start` config with a `deny` entry per path, which the Codex sandbox enforces. The profile replaces the `sandbox` parameter, which would override it. It extends the user's own `default_permissions` when they have one, otherwise `:workspace` with the user's `sandbox_workspace_write` network access and writable roots, read with `config/read`.
- Muse, opencode and pi: nothing. `docs/agent-providers.md` lists the gap.

### File modes

`Db.layer` creates `hinacode.sqlite` 0600 before SQLite opens it, and tightens an existing database, `-wal` and `-shm` to 0600. SQLite creates the WAL and SHM files with the database file's mode.

## Out of scope

- Turning on Claude Code's sandbox for HinaCode threads. It would close the shell gap, but it also limits network access and writes for every command.
- References to an external secret manager, such as 1Password `op://` URIs resolved per use, so that no value is ever written to disk. This is the follow-up the threat model points to.
- Encryption on top of the OS keyring, or a key file for the cloud. See the ADR.
- A per-thread OS user or a sandbox for providers that have none.

## Verification

- Unit and integration tests next to the source:
  - Backend mapping: Linux `basic_text` and `unknown` mean `none`, and a `none` keyring stores plaintext.
  - Resealing: plaintext rows get sealed when a real keyring is present.
  - `request_secret`: the file is removed after the turn ends and after it is stopped, Scratch sweeps leftover folders at startup, and the value appears in no event, message, log or tool result.
  - Database file modes after open.
  - Claude deny rules in the settings file, and the Codex permission profile at thread start.
- A real Codex 0.172.0 app-server reports `activePermissionProfile: hinacode` for the profile we send, keeps the user's network access, and its sandbox answers `Permission denied` for a denied path.
- `verify-hinacode`: open Settings, Integrations under the mock keychain and with `--password-store=basic`, and capture the status line and the warning.
