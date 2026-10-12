# Agent accounts

Status: Building
Date: 2026-10-12

## Problem

A developer with a personal and a work subscription, or two Claude Max seats to spread rate limits, wants each thread to bill a chosen account. Today kkcode runs every thread as whoever the CLI is signed in as, so switching means signing out and back in from a terminal, which also switches every other running thread.

## User flow

1. Settings > Models lists, per agent, the CLI's own login and every account added in kkcode, each with its email and plan.
2. "Add account" asks for a name, then starts sign-in. The browser opens on the agent's sign-in page, and the dialog shows the same URL as a link. For Claude Code the dialog also takes the code the page shows when the browser could not reach the CLI. The dialog closes when the agent reports the login. A browser already signed in to ChatGPT finishes the Codex sign-in without asking, so adding a second ChatGPT account needs a private window or switching the browser's account first.
3. Each added account can be renamed, signed out, signed in again or removed. "Account for new threads" picks the default per agent.
4. A new thread starts on the agent's default account. When the agent has more than one account, the composer shows an account picker next to the model. It is disabled once the thread has a provider session, because the transcript lives in that account's home.

## Design

- An account is a home directory: Claude Code reads its login and transcripts from `CLAUDE_CONFIG_DIR`, Codex from `CODEX_HOME`. The home is derived, not stored: `<userData>/accounts/<id>`. On macOS Claude Code names its keychain entry `Claude Code-credentials-<hash of the config dir>`, so separate homes hold separate logins.
- Table `agent_account (id, provider, name, created_at)` and a nullable `thread.account_id` (migration `0009_agent_accounts`). Null is the CLI's own login, so existing threads need no backfill. `Settings.defaultAccount` holds the default per agent, like `defaultModel`.
- `AgentAccounts` service: list, create, rename, remove, home. `Threads` sets `accountId` from the default on create and when the agent changes, checks that the account belongs to the thread's agent, and refuses a change once `providerSessionId` is set.
- Delete rule: removing an account is refused while any thread, settled or archived ones included, still points at it. Nothing ever falls back to another login, so no turn bills an account the user did not pick. Removing signs the account out, then deletes its home.
- `RunTurnInput.home` and `AgentProvider.account(home)`. Claude sets `CLAUDE_CONFIG_DIR` on the session and on the probes. Codex runs one app-server per home, spawned with `CODEX_HOME` and respawned after it dies; a turn's interrupt and steer go to the app-server that started it. Models are listed from the default home.
- Sign-in: Codex calls `account/login/start` `{ type: "chatgpt" }` and waits for `account/login/completed`; main opens `authUrl` through `externalUrl` (http(s) only). Claude spawns `claude auth login --claudeai`, which opens the browser itself and prints a fallback URL whose page shows a code to paste into the CLI's stdin. It finishes when the CLI exits. Sign-out is `claude auth logout` or `account/logout` in the account's home. A finished sign-in is pushed as `account.signIn`.
- rpc: `accounts.list`, `accounts.create`, `accounts.rename`, `accounts.delete`, `accounts.signIn`, `accounts.submitCode`, `accounts.cancelSignIn`, `accounts.signOut`, and `agents.account` takes an `accountId`. Inputs are schema-decoded like every rpc; account names are trimmed, non-empty and short.

## Out of scope

- Signing the CLI's own login in or out from kkcode. It belongs to the terminal and other tools share it.
- Sharing user-level settings, skills or `CLAUDE.md` with an added account. A new home starts empty, as a fresh CLI install would.
- API key or cloud-provider logins for added accounts. `claude auth login --console` and Codex API keys can come later.
- Moving a started thread to another account. Its session only exists in the old home.

## Verification

- `AgentAccounts.integration.test.ts` runs on real SQLite: create, the default account on thread creation and agent switch, the lock once a session is bound, and the delete rule.
- `codex/index.integration.test.ts` proves two homes get two fake app-servers with their own `CODEX_HOME`, and that interrupting one thread's turn reaches its own app-server.
- `ipc.integration.test.ts` covers the account rpc methods and their input decoding.
- With `verify-kkcode`: add a second Codex account in Settings > Models, start sign-in until the dialog shows the auth URL, cancel, then open a thread and pick the account in the composer. Check both themes.
