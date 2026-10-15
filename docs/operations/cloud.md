# Run a kkcode cloud on a home server

A cloud is the kkcode binary in serve mode: no window, its own database, agents and worktrees on that machine, reachable by the phone today and by the desktop in a later slice. Design: `docs/features/2026-10-14-remote-clouds.md`.

## Start it

From a checkout, with its own data directory:

```sh
KKCODE_USER_DATA="$HOME/.kkcode-cloud" pnpm serve
```

A packaged build takes the same form: `kkcode serve` with `KKCODE_USER_DATA` set. The daemon prints one pairing URL per reachable address (Tailscale first, then LAN). Paste or scan one in the mobile app. The data directory holds `kkcode.sqlite`, attachments, and the pairing token inside the database. A desktop app and a cloud refuse to share one directory.

Options, flags first, then environment, then stored settings:

| Flag             | Environment                   | Meaning                                                       |
| ---------------- | ----------------------------- | ------------------------------------------------------------- |
| `--port <n>`     | `KKCODE_SERVE_PORT`           | Listener port, default 48081                                  |
| `--host <host>`  | `KKCODE_SERVE_HOST`           | Bind host, default `0.0.0.0`                                  |
| `--rotate-token` | `KKCODE_SERVE_ROTATE_TOKEN=1` | Replace the pairing token at boot and disconnect every client |
| (none)           | `KKCODE_SERVE=1`              | Serve mode without the `serve` command, for a service manager |

On Linux the Electron binary still wants a display even with no window, so start it under Xvfb until the plain Node daemon lands: `xvfb-run -a kkcode serve`. On macOS it runs as-is and hides its dock icon.

## Keep it running

- systemd user unit: `ExecStart=/usr/bin/xvfb-run -a /path/to/kkcode serve`, `Environment=KKCODE_USER_DATA=%h/.kkcode-cloud`, `Restart=on-failure`. `SIGTERM` is handled: running turns persist before exit, at most 5 seconds.
- launchd: same command without `xvfb-run`, `KeepAlive` true, stdout to a log file so the pairing URL survives the boot.
- Agent logins belong to the cloud: run `claude login`, `codex login`, `muse login` and `gh auth login` in a shell on that machine, once. kkcode never signs in for you.

## Troubleshooting

- `kkcode serve failed ... remote listener failed: EADDRINUSE`: another cloud or app holds the port. Pick another with `--port`.
- `kkcode is already running on ...`: the desktop app uses the same `KKCODE_USER_DATA`. Give the cloud its own.
- Phone cannot connect: use the Tailscale URL the daemon printed, and confirm both devices are on the same tailnet. The transport is plain WebSocket, encrypted by Tailscale or your LAN only.
- `The requested module 'electron' does not provide an export named ...`: the shell exported `ELECTRON_RUN_AS_NODE=1` (terminals hosted inside another Electron app do), so the binary ran as plain Node. Unset it for the daemon: `env -u ELECTRON_RUN_AS_NODE kkcode serve`. `pnpm serve` already does this.
- Lost the pairing URL: restart the daemon. It reprints the same token. Restart with `--rotate-token` only when a token may have leaked, since every client must pair again.
- First boot on macOS pauses before printing: `safeStorage` asks the Keychain for access the first time a secret is stored. Run it once in a terminal and answer the prompt. Under launchd with no one to answer, the lookup fails on its own and the daemon falls back to plaintext secrets with a warning in the log.
