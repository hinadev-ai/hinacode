# Run a hinacode cloud on a home server

A cloud is `hinacode serve`: the app's services as a plain Node program, with no window and no Electron. It has its own database, and agents and worktrees on that machine, reachable by the phone and by the desktop's environments. Design: `docs/features/2026-10-14-remote-clouds.md`.

## Start it

Node 24.22.1 or newer (26.12.1 or newer on Node 26):

```sh
npx hinacode serve
```

From a checkout, `pnpm serve` builds and runs the same daemon.

The daemon keeps its data in `HINACODE_USER_DATA`, default `~/.hinacode-cloud`, and prints the pairing block: a phone URL with every reachable address (Tailscale first, then LAN) and a QR code to scan in the mobile app, then one URL per address to add under Settings > Environments on the desktop. Container and VM bridges such as `docker0` and `br-*` are left out. `hinacode pair` prints the same block again, whether the daemon runs or not. The data directory holds `hinacode.sqlite`, attachments, and the pairing token inside the database. A desktop app and a cloud refuse to share one directory, and so do two clouds.

Options, flags first, then environment, then stored settings:

| Flag              | Environment                     | Meaning                                                       |
| ----------------- | ------------------------------- | ------------------------------------------------------------- |
| `--port <n>`      | `HINACODE_SERVE_PORT`           | Listener port, default 48081                                  |
| `--host <host>`   | `HINACODE_SERVE_HOST`           | Bind host, default `0.0.0.0`                                  |
| `--rotate-token`  | `HINACODE_SERVE_ROTATE_TOKEN=1` | Replace the pairing token at boot and disconnect every client |
| `--relay on\|off` | `HINACODE_SERVE_RELAY`          | Link the cloud to the HinaCode relay, or unlink it            |
|                   | `HINACODE_SERVE_AUTO_UPDATE=0`  | Do not install new releases on its own when idle              |

Nothing compiles at install: `node-pty` ships prebuilds for macOS, Linux and Windows on x64 and arm64.

## Reach it from anywhere

Without Tailscale, a cloud is reachable only on its LAN. The HinaCode relay gives it a public hostname through a Cloudflare tunnel, so the phone and the desktop reach it from any network. Design: `docs/features/2026-10-24-relay.md`.

1. Install `cloudflared` and put it on the `PATH` of the service that runs the cloud.
2. Run it once with the relay on:

   ```sh
   hinacode serve --relay on
   ```

3. It prints `Open <url> to link this cloud to your HinaCode account. The code is <code>.` Open the URL on any device, sign in, and approve the machine with that code. The link expires after 10 minutes.

The cloud then prints the pairing block with its relay hostname in every URL, and clients dial it before the direct addresses. Later boots keep the relay running without the flag and without calling the relay service. `HINACODE_RELAY_URL` points the cloud at another relay service, such as a local `wrangler dev`.

`hinacode serve --relay off` unlinks the machine and deletes its tunnel. Without `cloudflared` on `PATH`, the cloud retries every minute and connects once it is installed.

## Keep it running

- Install it once instead of resolving it on every boot: `npm install -g --allow-scripts=node-pty hinacode`, then run `hinacode serve`. npm 11 skips node-pty's install script without that flag, and the terminal then fails to start.
- A cloud installed with `npm install -g` updates itself: it checks npm every 4 hours and installs a new release once no turn, queued message, setup script or terminal is running. To update right away, use Settings, Environments, `Update all` on the desktop. The cloud installs the release into the same npm prefix and restarts itself under the same pid, so a systemd or launchd service keeps running it. A cloud started with `npx` or from a checkout does not update itself. By hand, run `npm install -g --allow-scripts=node-pty hinacode@latest` and restart.
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
