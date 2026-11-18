# Run a cloud as a service

Status: Shipped
Date: 2026-11-17

## Problem

`docs/operations/cloud.md` tells people to write their own launchd plist or systemd unit for `hinacode serve`. Each one is different, so HinaCode cannot know where its output goes, and the log grows forever. A hand-written plist on a Mac mini reached a week of output with nothing bounding it. Getting the PATH, the restart policy and the log path right takes several tries.

## User flow

1. Install the cloud with `npm install -g --allow-scripts=node-pty hinacode`, or unpack the executable.
2. Run `hinacode serve` once in a terminal to pair or link the relay, then stop it.
3. Run `hinacode service install`. It writes the service, starts it, and prints where its log is. Running it again rewrites the service and restarts it.
4. `hinacode service uninstall` stops the service and removes it. The data directory stays.

## Design

- `src/cli/service.ts` renders the service for the `hinacode` the command runs from: the executable itself, or the npm bin script, which `#!/usr/bin/env node` starts from the PATH the service carries. It refuses an `npx` cache path, which npm can delete at any time.
- The service sets `PATH` from the shell that installs it and `HINACODE_USER_DATA` to the data directory, so `--data` carries over.
- macOS: `~/Library/LaunchAgents/ai.hinacode.serve.plist`, `KeepAlive`, output to `~/Library/Logs/hinacode/serve.log`, loaded with `launchctl bootout` and `bootstrap` in the `gui/<uid>` domain. The plist sets `HINACODE_SERVE_LOG` to the log path.
- Linux: `~/.config/systemd/user/hinacode.service`, `Restart=on-failure`, output to the journal, which bounds itself. Enabled and restarted with `systemctl --user`. When the user does not linger, it prints the `loginctl enable-linger` command, which needs the user's consent.
- `hinacode serve` with `HINACODE_SERVE_LOG` checks the file at boot and every 10 minutes. Over 10 MB, it copies the file to `serve.log.1` and empties it in place. launchd holds the file open for appending, so a rename would leave it writing into the old file; after the truncate its next write lands at the start. One old file is kept, so the log takes at most about 20 MB.
- Install stops the existing service first, then refuses when another `hinacode serve` still holds the data directory, so a foreground cloud and the service never fight over it.

## Out of scope

- Windows services.
- A system-wide service. The cloud runs agents with the user's logins, so it is a user service.
- Several services on one machine. Two clouds need two data directories and two labels; nobody has asked for that.

## Verification

- `src/cli/service.test.ts` renders the plist and the unit, with paths that need escaping, and refuses an `npx` path.
- `src/main/serve.test.ts` bounds a log that a writer holds open for appending, and leaves a small one alone.
- On Linux: `hinacode service install` from a staged npm package, check `systemctl --user status hinacode` and the journal, then `uninstall`.
- On macOS: load the rendered plist under a test label and data directory, grow its log past 10 MB, restart it, and see the log rotated while launchd keeps writing.
