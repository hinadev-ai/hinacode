# Server npm package

Status: Building
Date: 2026-10-28

## Problem

A developer running a cloud on a headless server installs `hinacode` from npm. The tarball was small, but its manifest was the desktop app's manifest. npm installed the full desktop dependency tree on that server: the Claude Agent SDK's bundled platform binaries (which never run, since the provider uses the developer's own `claude`), `electron-updater`, renderer-only packages, and a second copy of packages the bundle already contained. Publishing also required the full electron-vite build, renderer included, and a release step that edited the desktop manifest before `npm publish`.

## User flow

Nothing changes for the developer. `npx hinacode serve` and `npm install -g --allow-scripts=node-pty hinacode` work as before, print the same pairing block, and keep data in `HINACODE_USER_DATA`. The install is smaller and faster. `pnpm serve` from a checkout now builds only the server.

## Design

- `vite.server.config.ts` builds `src/main/daemon.ts` to `out/server/daemon.js` with plain Vite in SSR mode. electron-vite builds only the desktop entry; electron-builder excludes `out/server/` from the asar.
- `scripts/server-package.ts` holds the one externals list (`node-pty`, `playwright-core`) and the published manifest shape. The bundler bundles everything else, including the agent SDKs and Effect. `node-pty` stays external because it spawns a native binary from its package. `playwright-core` stays external because it reads its browser registry from files beside its runtime. The Browser service imports `playwright-core`; the full `playwright` package is a devDependency used by e2e and browser installs.
- `scripts/stage-server-package.ts` writes `dist-npm/` with a generated `package.json` (name `hinacode`, `bin`, `files`, engines from the root, and only the externals as dependencies), the `bin` shim and the built output. The layout keeps `package.json` two levels above the daemon entry, so the version lookup and the cloud self-updater's prefix detection keep working, from a checkout and from a global install alike. The repository root is `private`, so publishing it by mistake fails.
- `scripts/verify-server-package.ts` copies the staged package to a temporary directory outside the checkout, installs it with npm, checks the installed tree carries no Electron or bundled-away packages, runs `--version` and `--help`, boots `serve` against a throwaway data directory, and checks a clean SIGTERM exit. CI runs it on app changes, and the release `npm` job runs it before publishing.
- `pnpm-workspace.yaml` overrides cut the Claude Agent SDK's platform binary packages from workspace installs. Renderer-only packages (`anser`, `pele`, the Geist font) moved to `devDependencies`, where the releasing runbook already said bundled renderer packages belong.

## Out of scope

- Splitting `src/main` into workspace packages or running the local server as a child process of the desktop. The in-process layer graph and its `AppOptions` and `DesktopCalls` seams stay.
- A launcher package or per-platform archives. The published tarball carries the bundled JavaScript directly. A cloud still needs Node, which it needs for the agent CLIs anyway.
- Renaming the npm package. The cloud self-updater polls the registry for `hinacode`, detects its install prefix from that directory name, and trusted publishing is bound to it.

## Verification

- `pnpm build:server && pnpm stage:server && pnpm verify:server` installs the staged tarball shape away from the checkout and boots a real cloud from it.
- `node --test scripts/server-package.test.ts` covers the externals matching and manifest generation.
- `pnpm build` still produces the desktop app, and `pnpm test` covers the Browser service against `playwright-core`.
