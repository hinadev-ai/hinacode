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

On Linux, pass `--ozone-platform=headless` so Electron does not look for an X display: `kkcode serve --ozone-platform=headless`. Without it, a machine with no display aborts at boot with `Missing X server or $DISPLAY`. `pnpm serve` already passes it. On macOS the flag is ignored, and the daemon hides its dock icon.

## Keep it running

- systemd user unit: `ExecStart=/path/to/kkcode serve --ozone-platform=headless`, `Environment=KKCODE_USER_DATA=%h/.kkcode-cloud`, `Restart=on-failure`. `SIGTERM` is handled: running turns persist before exit, at most 5 seconds.
- launchd: `kkcode serve`, `KeepAlive` true, stdout to a log file so the pairing URL survives the boot.
- Agent logins belong to the cloud: run `claude login`, `codex login`, `muse login` and `gh auth login` in a shell on that machine, once. kkcode never signs in for you.

## Troubleshooting

- `kkcode serve failed ... remote listener failed: EADDRINUSE`: another cloud or app holds the port. Pick another with `--port`.
- `kkcode is already running on ...`: the desktop app uses the same `KKCODE_USER_DATA`. Give the cloud its own.
- Phone cannot connect: use the Tailscale URL the daemon printed, and confirm both devices are on the same tailnet. The transport is plain WebSocket, encrypted by Tailscale or your LAN only.
- `The requested module 'electron' does not provide an export named ...`: the shell exported `ELECTRON_RUN_AS_NODE=1` (terminals hosted inside another Electron app do), so the binary ran as plain Node. Unset it for the daemon: `env -u ELECTRON_RUN_AS_NODE kkcode serve`. `pnpm serve` already does this.
- Lost the pairing URL: restart the daemon. It reprints the same token. Restart with `--rotate-token` only when a token may have leaked, since every client must pair again.
- Secrets on a cloud never touch the login Keychain. Serve mode seals them with Chromium's public mock key, so on macOS they have the same protection as on a Linux server with no keyring: the data directory's file permissions. A cloud that first booted before this change cannot read its old pairing token, logs `secret remote.token was sealed under another key`, and prints a new pairing URL. Pair its clients again.
