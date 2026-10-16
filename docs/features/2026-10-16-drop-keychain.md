# Fewer Keychain prompts

Status: Building
Date: 2026-10-16

## Problem

`services/Secrets.ts` encrypts secrets with Electron `safeStorage`. On macOS the key lives in the login Keychain item `kkcode Safe Storage`. A binary missing from that item's access list gets a dialog asking for the login password, and the dialog comes back on every boot, because `RemoteAccess` decrypts `remote.token` while its layer is built.

The signed release app is always on the list for an item it created, and a Developer ID signature keeps it on the list across updates. The prompts come from every other binary that uses the name `kkcode`:

- `pnpm dev` runs a `KKCode.app` that `scripts/dev-app-identity.mjs` re-signs ad hoc inside each checkout's `node_modules`. KKCode works in a worktree per thread, so every worktree is a new binary and a new prompt.
- `pnpm serve`, e2e runs, `verify-kkcode` and perf runs are the same unpackaged Electron. Today they stay out of the Keychain only because seven call sites remember to pass `--use-mock-keychain`, and `e2e/support/startup-observer.cjs` refuses to start without it.
- `kkcode serve` under launchd has nobody to answer a prompt. `docs/operations/cloud.md` tells you to answer it once in a terminal.

Windows (DPAPI) never prompts. On Linux, a server without a keyring already falls back to plaintext.

## Options considered

- **Plaintext in SQLite.** Removes the prompt everywhere, but gives up protection we get for free on Windows and Linux desktops, and every user needs a migration.
- **Keep `safeStorage` in the release app only (chosen).** Orca keeps `safeStorage` too. It adds a 5-second Keychain probe in a child process for headless serve, selects a Linux keyring backend, and uses a separate `orca-dev` data directory for dev builds. We take the dev split, and handle serve with the mock key instead of a probe.

## Design

One rule: only the packaged desktop app uses the real Keychain.

- `src/main/index.ts` calls `app.commandLine.appendSwitch("use-mock-keychain")` before anything touches `safeStorage`, when `!app.isPackaged` or in serve mode. Chromium reads the switch when it fetches the key (`KeychainKeyProvider`'s `GetKeyTask`), so adding it at runtime has the same effect as passing it on the command line. The mock key is Chromium's public test key. Secrets in these profiles are only obfuscated, which is the same protection a Linux server already gets.
- An unpackaged run without `KKCODE_USER_DATA` defaults to `<appData>/kkcode-dev`, not `<appData>/kkcode`. The mock key cannot decrypt the release app's secrets, so a dev run on the release profile would lose its tokens. That was already unusual, because the single-instance lock stops `pnpm dev` while the release app is open.
- `Secrets.get` treats a secret it cannot decrypt as unset and logs the secret's name. Today it throws, and because `remote.token` is read at boot, a profile sealed under another key never starts. Now `RemoteAccess` issues a fresh token, and the user pastes the Linear key again.
- The explicit `--use-mock-keychain` flags in e2e, `verify-kkcode`, `scripts/perf/memory.mjs` and the README go away, and so does the e2e startup guard. `scripts/perf/packaged.mjs` keeps its flag, because it runs the packaged app.

Migration: none. The release app's rows are untouched. A dev profile or a cloud with rows sealed under the real key reads them as unset once: a cloud prints a new pairing URL and its phones and desktops pair again. A Linear key has to be saved again.

AGENTS.md: secrets still go through `services/Secrets.ts` and `safeStorage`. The new rule is that only the packaged desktop app uses the real Keychain, so a launch never needs `--use-mock-keychain`.

## Out of scope

- Probing the Keychain for packaged desktop runs. In a GUI session the release app prompts at most once, the first time it meets an item that another binary created.
- Linux keyring backend selection for tiling window managers. Nobody has reported it.
- Deleting the old Keychain item or the old dev profiles.

## Verification

- `Secrets.integration.test.ts`: a row sealed under another key reads as unset, and saving it again works.
- A probe Electron script named `kkcode-mock-probe`, so it can never reach the real item, adds the switch at runtime under a temporary `HOME`. Encrypting and decrypting must succeed, and no `kkcode-mock-probe Safe Storage` item may appear in the login Keychain.
- `pnpm test:e2e` passes without the flag and without the guard.
