# Update clouds from the desktop

Status: Building
Date: 2026-10-20

## Problem

A developer with clouds on two machines updates each one by hand: ssh in, `npm install -g hinacode@latest`, restart the service. They put it off, the clouds fall behind the desktop, and a cloud that falls far enough behind stops connecting. The desktop already knows every cloud and can call it. Updating should be one click there.

## User flow

1. A cloud checks npm at boot and every 4 hours, like the desktop checks its releases. Opening Settings, Environments asks every connected cloud to check again, so a release published a minute ago shows up.
2. Settings, Environments shows each cloud's version. A cloud with a newer release shows `Update to 0.1.0-alpha.12`, and the page shows `Update all` when any cloud has one.
3. Clicking installs the release on the cloud, which then restarts itself into it. The row reads `Updating to …` while npm runs. The cloud drops, reconnects on its own, and the row shows the new version.
4. If npm fails, the row shows npm's error and a `Check for updates` button, and the cloud keeps running the old version. Checking again offers the update again.

## Design

### Data

No new types. A cloud answers `updates.status` with the `UpdateStatus` the desktop already uses:

| `UpdateState` | On a cloud                                                         |
| ------------- | ------------------------------------------------------------------ |
| `unsupported` | Not a global npm install (a checkout, `npx`), or Windows           |
| `checking`    | Asking the registry for `hinacode`'s `latest` dist-tag             |
| `upToDate`    | `latest` is the running version                                    |
| `ready`       | `latest` is another version, and `updates.install` will install it |
| `downloading` | `npm install -g` is running                                        |
| `failed`      | The check or the install failed, with the message                  |

`updates.status`, `updates.check` and `updates.install` move from the `client` route to `named`, so the renderer asks the environment it names and This Mac when it names none. A cloud from before this change answers `unsupported` with its version, so the page still shows what it runs.

### Install and restart

`src/main/cloudUpdater.ts` provides `Updates` for `hinacode serve`.

- The package root is two levels above `out/main/daemon.js`. A global npm install keeps it at `<prefix>/lib/node_modules/hinacode`, so the updater installs into that `<prefix>` and no other. Any other layout is `unsupported`, so the updater never writes into a checkout or the `npx` cache.
- The check and the install use one registry, `npm_config_registry` or `https://registry.npmjs.org`. The registry's answer is decoded with a schema.
- `npm` runs with this `node`'s directory first on `PATH`, so it installs with the Node that runs the cloud, not whichever `node` comes first in the login shell. It passes `--allow-scripts=node-pty`, since npm 11 skips install scripts it was not told to run.
- `install` answers at once and installs in the background, so the call never spans the restart.
- After npm succeeds, the daemon stops the app layer the way `SIGTERM` does (running turns persist, at most 5 seconds), then calls `process.execve` with its own `argv`. The process keeps its pid, so systemd, launchd and a bare terminal all keep it. The `daemon.pid` lock treats its own pid as free.

## Out of scope

- Updating a cloud the desktop cannot talk to. `REMOTE_PROTOCOL_VERSION` has been 1 since the remote protocol shipped. When it changes, the release notes say to update clouds before the desktop.
- Updating automatically, or waiting for running turns to finish. Clicking update stops running turns the way restarting the desktop does.
- Installs other than global npm: the AppImage, a checkout, `npx`, Windows.

## Verification

- `src/main/cloudUpdater.integration.test.ts` runs the updater against a registry on a loopback port: up to date, a newer `latest`, a registry error, and a package root outside a global install.
- By hand, a local Verdaccio serves two builds of this branch. A cloud installed globally from the older one pairs with a dev desktop. Update all brings it back on the newer version with the same pid. Screenshots of Settings, Environments before and after.
