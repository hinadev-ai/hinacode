# Run a hinacode cloud on a home server

A cloud is `hinacode serve`: the app's services as a plain Node program, with no window and no Electron. It has its own database, and agents and worktrees on that machine, reachable by the phone and by the desktop's environments. Design: `docs/features/2026-10-14-remote-clouds.md`.

## Start it

Node 24 or newer:

```sh
npx hinacode serve
```

From a checkout, `pnpm serve` builds and runs the same daemon.

The daemon keeps its data in `HINACODE_USER_DATA`, default `~/.hinacode-cloud`, and prints the pairing block: a phone URL with every reachable address (Tailscale first, then LAN) and a QR code to scan in the mobile app, then one URL per address to add under Settings > Environments on the desktop. Container and VM bridges such as `docker0` and `br-*` are left out. `hinacode pair` prints the same block again, whether the daemon runs or not. The data directory holds `hinacode.sqlite`, attachments, and the pairing token inside the database. A desktop app and a cloud refuse to share one directory, and so do two clouds.

Options, flags first, then environment, then stored settings:

| Flag             | Environment                     | Meaning                                                       |
| ---------------- | ------------------------------- | ------------------------------------------------------------- |
| `--port <n>`     | `HINACODE_SERVE_PORT`           | Listener port, default 48081                                  |
| `--host <host>`  | `HINACODE_SERVE_HOST`           | Bind host, default `0.0.0.0`                                  |
| `--rotate-token` | `HINACODE_SERVE_ROTATE_TOKEN=1` | Replace the pairing token at boot and disconnect every client |

Nothing compiles at install: `node-pty` ships prebuilds for macOS, Linux and Windows on x64 and arm64.

## Keep it running

- Install it once instead of resolving it on every boot: `npm install -g hinacode`, then run `hinacode serve`. Update with `npm install -g hinacode@latest` and a restart.
- systemd user unit: `ExecStart=/usr/bin/env hinacode serve`, `Environment=PATH=...` with the directories of `node`, `claude`, `codex` and `gh`, `Restart=on-failure`, `StandardOutput=append:%h/.hinacode-cloud/serve.log`. Run `loginctl enable-linger $USER` so it starts at boot without a login. `SIGTERM` is handled: running turns persist before exit, at most 5 seconds.
- launchd: `hinacode serve`, `KeepAlive` true, stdout to a log file so the pairing URL survives the boot.
- Agent logins belong to the cloud: run `claude login`, `codex login`, `muse login` and `gh auth login` in a shell on that machine, once. hinacode never signs in for you.
- A firewall must let the listener port in. With `ufw`, open it on the Tailscale interface only: `sudo ufw allow in on tailscale0 to any port 48081 proto tcp`.

## Troubleshooting

- `hinacode serve: another hinacode serve (pid N) uses ...` or `the HinaCode app (pid N) uses ...`: give this cloud its own `HINACODE_USER_DATA`.
- `hinacode serve: port 48081 is in use ...`: another cloud, or the desktop app's Settings > Remote, holds the port. Pick another with `--port`.
- `automation webhook listener failed ... 48080`: the desktop app on the same machine holds the webhook port. The cloud keeps running; only its webhooks are off.
- Phone cannot connect: use the Tailscale URL the daemon printed, and confirm both devices are on the same tailnet and the firewall allows the port. The transport is plain WebSocket, encrypted by Tailscale or your LAN only.
- Lost the pairing URL: run `hinacode pair` with the same `HINACODE_USER_DATA`. It prints the same token without a restart. Restart with `--rotate-token` only when a token may have leaked, since every client must pair again.
- Secrets on a cloud are stored as plaintext in its database, since a headless machine has no keyring to unlock without a password. The data directory is created `0700`; its permissions are the protection. A cloud that an older release ran on macOS sealed its secrets with Chromium's mock key, logs `secret remote.token was sealed under another key`, and prints a new pairing URL. Pair its clients again.
