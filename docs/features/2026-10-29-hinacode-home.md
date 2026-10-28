# One home for HinaCode data

Status: Building
Date: 2026-10-29

## Problem

HinaCode spreads its data over `~/Library/Application Support/kkcode` (or `kkcode-dev`), Chromium's profile files, SQLite rows that hold settings, and `/tmp` folders agents create. A developer who wants to back up, inspect, reset or hand-edit their setup has to know Electron's layout and open the database. Agents leave scratch files in `/tmp` that outlive the thread. The Settings > Accounts page spawns a Claude CLI every time it opens just to show an email.

## User flow

1. The developer updates HinaCode. On first launch everything in the old profile moves to `~/.hinacode`. Threads, chats, attachments, accounts, settings and the in-app browser's logins all survive.
2. They open `~/.hinacode/settings.json` or `keybindings.json` in an editor, change a value, and HinaCode reads it the next time it loads settings.
3. Settings > Accounts shows each account's email and plan immediately from `~/.hinacode/cache/`. A refresh asks the CLI again.
4. An agent writes experiments into the thread's scratch folder that its instructions name. Archiving or deleting the thread removes the folder.

## Design

```
~/.hinacode/                       HINACODE_USER_DATA overrides it. Unpackaged runs use ~/.hinacode-dev.
  hinacode.sqlite{,-wal,-shm}      threads, messages, projects, accounts, sealed secrets
  settings.json                    Settings (environment), only keys that differ from defaults are required
  client-settings.json             ClientSettings without keybindings
  keybindings.json                 { "<CommandId>": "<chord>" }, user overrides only
  chats/<threadId>/
  attachments/<threadId>/
  cache/<label>_<provider>.json    { accountId, account, fetchedAt }
  scratch/<YYYYMMDD-HHmmss>-<slug>-<threadId>/
  tiny-vm/  cloudflared/  accounts/  resource-monitor/
  chromium/                        Electron's userData: localStorage, cookies, caches, SingletonLock
```

- **Data dir.** `src/main/index.ts` resolves the data dir and points Electron's `userData` at `<dataDir>/chromium`, so Chromium's files stay out of the way and HinaCode's files sit at the top. `makeAppLayer` keeps receiving the data dir as `userData`.
- **Moving an existing profile.** Before the single-instance lock, if the data dir does not exist and `<appData>/kkcode` (`kkcode-dev` for unpackaged runs) does, it is renamed to `<dataDir>/chromium` and HinaCode's own entries move up a level. Absolute paths under the old root are rewritten in `message.parts`, `thread.queue` and `agent_account.config_dir`. The chats project row already follows `ensureChats`. A run with `HINACODE_USER_DATA` never moves anything.
- **Settings files.** `makeSettingStore` reads and writes a JSON file instead of `setting` rows. Writes go to a temp file and rename. A missing file means defaults; an unreadable one fails with a persistence error naming the file. The `setting` table keeps only sealed secrets. A migration copies existing setting rows into the files next to the database once and deletes the rows.
- **Account cache.** `AgentLogins.account` returns `cache/<label>_<provider>.json` when its `accountId` matches, and otherwise asks the provider and writes the file. `<label>` is the account's name, or `defaultAccountName[provider] ?? "default"` for the CLI's own login, slugified. A signed-out result is not cached, so a login made in a terminal shows up next time. Removing an account deletes its file. The accounts page can force a refresh.
- **Scratch.** Each turn ensures `<dataDir>/scratch/<createdAt>-<slug>-<threadId>/` exists and names it in the environment instructions. The folder is found by its `-<threadId>` suffix, so a later title change keeps the same path and the same instructions. Archive and delete remove it.

## Out of scope

- Files macOS writes for any app, such as `~/Library/Preferences/<bundle>.plist`, saved window state and the updater's ShipIt cache.
- Watching settings files for live reload. The next read picks up an edit.
- Removing attachments and pulled VM files on archive. Nothing cleans them today either.
- The cloud daemon keeps `~/.hinacode-cloud`, so a desktop and a cloud on one machine never share a database.

## Verification

- Launch with a copy of a real `kkcode` profile as the legacy dir. Threads, chats, attachments and settings load, and nothing new appears under `~/Library/Application Support`.
- Change a keybinding in the UI and see `keybindings.json` change. Edit `settings.json` by hand and see the value after reopening Settings.
- Open Settings > Accounts twice. The second time no Claude CLI starts.
- Run a turn, see the scratch path in the instructions, archive the thread and see the folder gone.
- Tests: `settingStore.test.ts`, the settings migration test, `AgentLogins` cache tests, `Threads` archive and delete tests.
