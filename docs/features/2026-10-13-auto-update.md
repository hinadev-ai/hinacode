# Auto update

Status: Shipped
Date: 2026-10-13

## Problem

hinacode ships as a downloaded app, and main moves fast. Today a developer has to notice a new release, download the zip, clear the quarantine flag and replace the app by hand, so most installs stay on whatever build they first downloaded and keep the bugs fixed since.

## User flow

1. The developer installs HinaCode once from the DMG on this repository's GitHub releases page.
2. While hinacode runs, it checks for a newer release at launch and every four hours, and downloads it in the background. Nothing on screen changes while that happens.
3. Once the zip downloads, Settings, General offers `Restart to update`. An updater error clears readiness and hides the button.
4. Clicking it quits hinacode, swaps in the new version and relaunches. Running turns get the same five-second quit window as a normal quit.
5. If the developer ignores the button, the update installs the next time they quit hinacode.
6. Settings, General shows the running version and what the updater is doing. `Check for updates` checks right away, and becomes `Restart to update` once a release has downloaded.

## Design

`electron-builder` packages a signed, notarized macOS arm64 DMG and zip, and publishes them with `latest-mac.yml` as a release of this repository (see `docs/adr/0018-releases-next-to-the-source.md`). The DMG is for the first install. The zip is what Squirrel.Mac installs.

`services/Updates.ts` wraps `electron-updater`. It only runs when `app.isPackaged`, so `pnpm dev` never checks and reports `unsupported`. It follows the updater's events into one `UpdateState`: idle, checking, up to date, downloading, ready or failed.

- rpc `updates.status` returns the running version and that state, for a renderer that mounts after it changed.
- rpc `updates.check` checks now. It does nothing while a check or download runs, or while a downloaded release waits, so a click cannot restart a download.
- push `update.changed` tells the renderer to ask for the status again.
- rpc `updates.install` calls `quitAndInstall`.

`electron-updater` checks the `sha512` in `latest-mac.yml`, and Squirrel.Mac refuses a bundle whose code signature does not satisfy the running app's designated requirement. Both checks happen before anything is installed, so the feed needs no extra trust handling.

## Out of scope

- Linux and Intel Macs. node-pty is native and has to be built on the target platform, and there is one release machine today.
- Release channels and staged rollouts. Add them when someone needs them.
- Release notes in the app. The tooltip links nothing, and the releases page has the notes.

## Verification

Squirrel.Mac only needs both builds to carry the same signing identity, so the full swap can be proved locally without notarization. Build version N signed with the local Apple Development identity and pointed at a `generic` feed on `127.0.0.1`. Build N+1 the same way, serve its zip and `latest-mac.yml`, launch N, wait for `Restart to update`, click it, and check that the relaunched app reports N+1. `docs/operations/releasing.md` covers the real Developer ID release.
