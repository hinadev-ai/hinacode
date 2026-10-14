# Electron binary

Use this when `pnpm dev` or `pnpm preview` fails with `Error: Electron uninstall`.

## Why it happens

Electron 44 dropped its `postinstall` download. `pnpm install` now leaves `node_modules/electron` without `dist/` or `path.txt`, and the binary downloads on the first `require("electron")` instead. electron-vite 5 never calls `require("electron")`. It reads `path.txt` directly and throws `Electron uninstall` when the file is missing. This shows up in every fresh worktree.

`electron.vite.config.ts` fixes this by setting `ELECTRON_EXEC_PATH` from `require("electron")`. The first `pnpm dev` in a new worktree prints `Downloading Electron binary...` and extracts the zip from `~/Library/Caches/electron` (or downloads it once if the cache is empty). Later runs skip the download.

The e2e suite gets the binary the same way, through `import electronBinary from "electron"` in `e2e/support/app.ts`.

## Steps

Nothing to run. `pnpm dev` downloads the binary when it is missing.

To fetch it ahead of time, for example before going offline:

```sh
pnpm exec install-electron
cat node_modules/electron/path.txt   # Electron.app/Contents/MacOS/Electron
```

## If it goes wrong

- **`Electron uninstall` on a branch from before this fix.** Run `pnpm exec install-electron` in that worktree, or rebase onto `main`.
- **`Electron failed to install correctly`.** The download or extraction failed. Check the network, then delete `node_modules/electron/dist` and `node_modules/electron/path.txt` and run `pnpm exec install-electron`. Set `force_no_cache=true` to skip a corrupt zip in `~/Library/Caches/electron`.
- **`SyntaxError: The requested module 'electron' does not provide an export named 'BrowserWindow'`.** `ELECTRON_RUN_AS_NODE=1` is set, so Electron starts as plain Node. Agent terminals inside kkcode and other Electron hosts inherit it. Run `env -u ELECTRON_RUN_AS_NODE pnpm dev`.
