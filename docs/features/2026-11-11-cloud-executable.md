# Cloud as an executable

Status: Building
Date: 2026-11-11

## Problem

A developer who wants a cloud on a fresh server has to install Node first, and a recent one: `^24.22.1 || >=26.12.1`. The server package's design assumed a cloud needs Node for its agents anyway, but `claude` and `codex` now ship as native binaries, so Node is often the only thing the developer installs just for HinaCode. A distribution's packaged Node is usually older than the range, so `npx hinacode serve` fails before it starts.

## User flow

1. The release lists `hinacode-<platform>-<arch>.tar.gz` for `linux-x64`, `linux-arm64` and `darwin-arm64`.
2. The developer downloads the one for their server, unpacks it anywhere and runs `./hinacode/hinacode serve`. Linux needs glibc 2.28 and `libatomic1`, as Node itself does; a minimal container image lacks `libatomic1`. Every command behaves as with `npx hinacode`, including `pair`, `ls` and `run`.
3. Settings, Environments shows the cloud's version with no update button. Updating means unpacking the next release over the old one and restarting.

## Design

- The archive holds one directory: `hinacode`, a [Node single executable application](https://nodejs.org/api/single-executable-applications.html) built with `node --build-sea`, and `node_modules/` with `node-pty` (this platform's prebuild only) and `playwright-core`. Those two stay files for the reason the npm package keeps them external: `node-pty` loads a native module and `playwright-core` reads files beside its runtime.
- `scripts/build-executable.ts` starts from the npm package's build in `out/server/` and bundles it again with esbuild into one CommonJS file. esbuild keeps each dynamic import lazy, so `hinacode ls` still never evaluates the daemon. A single executable's `require` loads only built-ins, so an esbuild plugin turns each external into `createRequire(process.execPath)(name)`, which resolves `node_modules/` beside the executable. The source keeps its plain imports.
- It then runs `node --build-sea` with the code cache on, signs the result ad hoc on macOS, copies the externals and writes the archive into `dist-exe/`. The executable embeds the Node that builds it, so CI builds with Node 26 on each target's own runner.
- The version is a JSON import, so the bundle carries it instead of reading `package.json` two directories up at runtime.
- `CloudUpdater` gets no package root inside an executable, so it reports `unsupported`, as it does for a checkout or `npx`.
- `scripts/verify-executable.ts` unpacks the archive outside the checkout, runs `--version` and `--help` from another directory, boots `serve`, opens a terminal and reads a command's output back, and checks a clean `SIGTERM` exit.

On Linux x64 the executable matches the npm package on Node 26 (`hyperfine`, 30 runs): `--version` in 101 ms against 94 ms, `serve` ready in 410 ms against 411 ms, and 162 MB resident against 148 MB. The archive is 50 MB. Two shapes that look simpler are much slower, which is why the bundle goes through esbuild:

| Bundle                                      | `--version`                                               |
| ------------------------------------------- | --------------------------------------------------------- |
| ES module main (`mainFormat: "module"`)     | 494 ms, the code cache does nothing                       |
| One CommonJS file from Rollup               | 379 ms, every inlined dynamic import evaluates at startup |
| CommonJS from esbuild, lazy dynamic imports | 101 ms                                                    |

Minifying saves another 8 ms, not worth unreadable stack traces in bug reports.

## Out of scope

- Updating an executable in place, the next slice. It needs a download and a swap, and `restartCommand` must stop passing `argv[1]` on: under Node it is the script, but in an executable it is the command line's own `argv[0]` and would arrive as a subcommand. The npm package keeps updating itself.
- Windows and macOS x64. Nobody runs a cloud on them yet.
- An install script or a package manager formula.
- Bun's `--compile`. It starts three times faster with bytecode, but `node-pty` under Bun loses every interactive shell to `SIGHUP` until [oven-sh/bun#41495](https://github.com/oven-sh/bun/pull/41495) ships.

## Verification

- `pnpm build:exe && pnpm verify:exe` builds the archive for this machine and boots it away from the checkout. CI runs both on `linux-x64`, and the release jobs run them on every target before uploading.
- By hand: the archive in a bare `ubuntu:24.04` container with no Node, plus `libatomic1`, boots `serve`, runs a terminal command and reports updates `unsupported`. On a workstation it completes a Claude Code turn.
