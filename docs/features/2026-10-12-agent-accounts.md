# Agent accounts

Status: Building
Date: 2026-10-12

## Problem

A developer with a personal and a work subscription, or two Claude Max seats to spread rate limits, wants each thread to bill a chosen account. Today hinacode runs every thread as whoever the CLI is signed in as, so switching means signing out and back in from a terminal, which also switches every other running thread.

## User flow

1. Settings > Models lists, per agent, the CLI's own login and every account added in hinacode, each with its email and plan.
2. "Add account" asks for a name, a binary path (prefilled with `claude` or `codex`) and a config directory (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`, absolute or `~`-prefixed). The dialog closes once the account is saved. hinacode does not sign it in.
3. A signed-out account row shows the command to run in a terminal, such as `CLAUDE_CONFIG_DIR=/Users/me/.claude-work claude auth login` or `CODEX_HOME=/Users/me/.codex-work codex login`, and a "Check again" button that probes the login again.
4. Each added account can be renamed or removed. "Account for new threads" picks the default per agent.
5. A new thread starts on the agent's default account. When the agent has more than one account, the composer shows an account picker next to the model. It is disabled once the thread has a provider session, because the transcript lives in that account's home.

## Design

- An account is a config directory plus the CLI binary run against it: Claude Code reads its login and transcripts from `CLAUDE_CONFIG_DIR`, Codex from `CODEX_HOME`. On macOS Claude Code names its keychain entry `Claude Code-credentials-<hash of the config dir>`, so separate directories hold separate logins. hinacode never signs in or out, so a typo in the directory creates nothing on disk; the CLI creates it on login.
- Table `agent_account (id, provider, name, created_at, config_dir, binary)` and a nullable `thread.account_id` (migrations `0010_agent_accounts` and `0012_account_home`). Null is the CLI's own login. Migration 0012 backfills accounts added before it with their old derived home, `<userData>/accounts/<id>`, and `binary = provider`. `Settings.defaultAccount` holds the default per agent, like `defaultModel`.
- `AgentAccounts` service: list, create, rename, remove, home. `create` expands a leading `~` and stores an absolute path. `Threads` sets `accountId` from the default on create and when the agent changes, checks that the account belongs to the thread's agent, and refuses a change once `providerSessionId` is set.
- Delete rule: removing an account is refused while any thread, settled or archived ones included, still points at it. Nothing ever falls back to another login, so no turn bills an account the user did not pick. Removing only drops the row; the config directory stays on disk.
- `RunTurnInput.home` and `AgentProvider.account(home)` take `{ dir, binary }`. Claude sets `CLAUDE_CONFIG_DIR` and runs the account's binary for the session and the probes. Codex runs one app-server per directory and binary, spawned with `CODEX_HOME` and respawned after it dies; a turn's interrupt and steer go to the app-server that started it. Models are listed from the default home.
- rpc: `accounts.list`, `accounts.create`, `accounts.rename`, `accounts.delete`, and `agents.account` takes an `accountId`. Inputs are schema-decoded like every rpc; account names are trimmed, non-empty and short, the config directory is absolute or `~`-prefixed, and the binary is non-empty.

## Out of scope

- Signing any account in or out from hinacode. The CLI's login command in a terminal already does it, and other tools share it.
- Sharing user-level settings, skills or `CLAUDE.md` with an added account. A new config directory starts empty, as a fresh CLI install would.
- Moving a started thread to another account. Its session only exists in the old home.

## Verification

- `AgentAccounts.integration.test.ts` runs on real SQLite: create with `~` expansion, the default account on thread creation and agent switch, the lock once a session is bound, and the delete rule, which leaves the directory on disk.
- `codex/index.integration.test.ts` proves two homes get two fake app-servers with their own `CODEX_HOME`, and that interrupting one thread's turn reaches its own app-server.
- `ipc.integration.test.ts` covers the account rpc methods and their input decoding.
- With `verify-hinacode`: add a second Codex account in Settings > Models with a fresh config directory, check that the row shows the `codex login` command, run it in a terminal, press "Check again", then open a thread and pick the account in the composer. Check both themes.
