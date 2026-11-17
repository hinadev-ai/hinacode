# Run a hinacode cloud on a home server

A cloud is `hinacode serve`: the app's services as a plain Node program, with no window and no Electron. It has its own database, and agents and worktrees on that machine, reachable by the phone and by the desktop's environments. Design: `docs/features/2026-10-14-remote-clouds.md`.

## Start it

On macOS (Apple silicon) or Linux (x64, arm64), one command installs the cloud and keeps it running:

```sh
curl -fsSL https://hinacode.app/install.sh | bash
```

It downloads the executable for this machine, checks it against the `.sha256` the release publishes next to it, and installs it into `~/.local/share/hinacode/versions/<version>/`, links `~/.local/bin/hinacode` to it, and runs `hinacode connect`. Connect installs `hinacode serve` as a service that starts at boot and restarts when it stops, waits until it listens, and prints the pairing block. Run the same command again to update; it restarts the service on the new release and deletes the old one.

| Platform | Service                                                                  | Log                                 |
| -------- | ------------------------------------------------------------------------ | ----------------------------------- |
| macOS    | launchd agent `~/Library/LaunchAgents/ai.hinacode.serve.plist`           | `~/Library/Logs/hinacode/serve.log` |
| Linux    | systemd user unit `~/.config/systemd/user/hinacode.service`, with linger | `~/.local/state/hinacode/serve.log` |

The service keeps the `PATH` of the shell that ran connect, so it finds the same `claude`, `codex` and `gh`. Run `hinacode connect` again after installing an agent CLI somewhere new. `hinacode disconnect` stops the service and removes it, and keeps the data. On Linux, connect runs `loginctl enable-linger` so the service starts at boot without a login; where that needs root, it says so and the service starts at login instead.

With Node 24.22.1 or newer (26.12.1 or newer on Node 26), run it in the foreground instead:

```sh
npx hinacode serve
```

Or download `hinacode-<platform>-<arch>.tar.gz` for `linux-x64`, `linux-arm64` or `darwin-arm64` from the [latest release](https://github.com/hinadev-ai/hinacode/releases/latest), unpack it anywhere and run the executable inside. Keep `node_modules/` next to it. On Linux it needs glibc 2.28 and `libatomic.so.1` (`apt install libatomic1` in a minimal image), the same as Node. It does not update itself; unpack the next release over it and restart.

```sh
tar -xzf hinacode-linux-x64.tar.gz && ./hinacode/hinacode serve
```

From a checkout, `pnpm serve` builds and runs the same daemon, and `pnpm build:exe` builds the archive for this machine into `dist-exe/`.

The daemon keeps its data in `HINACODE_USER_DATA`, default `~/.hinacode-cloud`, and prints the pairing block: a phone URL for its address and a QR code to scan in the mobile app, then the URL to add under Settings > Connections on the desktop. It listens on `--host`, else the address it used last, else `private`. `private` answers on the LAN and Tailscale and closes any connection with a public address on either end, so a phone at home connects with no flags. Anyone on the same network can reach the port, and only the pairing token keeps them out. Pass one address, such as a Tailscale address, to keep other networks out entirely, or `--host 127.0.0.1 --relay` to be reached only through the relay. A machine that already stored an address keeps it until you pass `--host private`. `0.0.0.0` and `::` are refused. It prints the block only to a terminal. Under a service or with its output redirected, it prints a pointer to `hinacode pair` instead, so the token never lands in a log. `hinacode pair` prints the same block again, whether the daemon runs or not. The data directory holds `hinacode.sqlite`, attachments, and the pairing token inside the database. A desktop app and a cloud refuse to share one directory, and so do two clouds. The daemon spots a desktop by the `SingletonLock` in the directory's `chromium/`.

Options, flags first, then environment, then stored settings:

| Flag                    | Environment                     | Meaning                                                       |
| ----------------------- | ------------------------------- | ------------------------------------------------------------- |
| `--port <n>`            | `HINACODE_SERVE_PORT`           | Listener port, default 48081                                  |
| `--host <host>`         | `HINACODE_SERVE_HOST`           | One bind address or `private`, the default                    |
| `--rotate-token`        | `HINACODE_SERVE_ROTATE_TOKEN=1` | Replace the pairing token at boot and disconnect every client |
| `--relay`, `--no-relay` | `HINACODE_SERVE_RELAY`          | Link the cloud to the HinaCode relay, or unlink it            |
|                         | `HINACODE_SERVE_AUTO_UPDATE=0`  | Do not install new releases on its own when idle              |

Nothing compiles at install: `node-pty` ships prebuilds for macOS, Linux and Windows on x64 and arm64.

## Run it in WSL

Code that lives in WSL runs best in WSL: its `node_modules`, toolchains and agents are Linux builds, and Windows git refuses a repository on `\\wsl.localhost` as dubious ownership. So the Windows app refuses a project folder under `\\wsl.localhost` or `\\wsl$` and points here instead.

1. In a WSL shell, install Node and start a cloud on loopback. WSL shares `localhost` with Windows, so nothing else can reach it:

   ```sh
   npx hinacode serve --host 127.0.0.1
   ```

2. In the Windows app, open Settings > Connections and paste the `hinacode://connect` URL it printed.
3. Add the project on that machine as `~/code/app`. Threads, worktrees, setup scripts and the terminal then run in WSL.

Sign in to the agents inside WSL too, such as `claude login`.

## Reach it from anywhere

Without Tailscale, a cloud is reachable only on its LAN. The HinaCode relay gives it a public hostname through a Cloudflare tunnel, so the phone and the desktop reach it from any network. Design: `docs/features/2026-10-24-relay.md`.

1. Run it once with the relay on:

   ```sh
   hinacode serve --relay
   ```

2. It prints a URL. Open it in any browser, on this machine or another, sign in, and approve the machine. On a machine with a display, it opens the browser for you. If the link expires, it prints a new one and keeps waiting.

The cloud then prints the pairing block with its relay hostname in every URL, and clients use it when none of the direct addresses answers. Later boots keep the relay running without the flag and without calling the relay service. `HINACODE_RELAY_URL` points the cloud at another relay service, such as a local `wrangler dev`.

`hinacode serve --relay off` unlinks the machine and deletes its tunnel. HinaCode uses the `cloudflared` on `PATH` when there is one. Otherwise it downloads the pinned release from Cloudflare's GitHub into `<data dir>/cloudflared/<version>/`, checks its SHA-256, and keeps it for later boots.

## Keep it running

- `hinacode connect` is the supported way. It works from the installer and from `npm install -g --allow-scripts=node-pty hinacode`, and refuses under `npx`, whose cache npm may clear under a running service. npm 11 skips node-pty's install script without that flag, and the terminal then fails to start.
- A cloud installed with `npm install -g` updates itself: it checks npm every 4 hours and installs a new release once no turn, queued message, setup script or terminal is running. To update right away, use Settings, Connections, `Update all` on the desktop. The cloud installs the release into the same npm prefix and restarts itself under the same pid, so a systemd or launchd service keeps running it. A cloud started with `npx` or from a checkout does not update itself. By hand, run `npm install -g --allow-scripts=node-pty hinacode@latest` and restart.
- `SIGTERM` is handled: running turns persist before exit, at most 5 seconds.
- Agent logins belong to the cloud: run `claude login`, `codex login`, `muse login` and `gh auth login` in a shell on that machine, once. hinacode never signs in for you.
- A firewall must let the listener port in. With `ufw`, open it on the Tailscale interface only: `sudo ufw allow in on tailscale0 to any port 48081 proto tcp`.

## Troubleshooting

- `hinacode connect: the cloud did not start in 30 seconds`: it prints the end of the service log. The usual causes are below.
- `hinacode connect: another hinacode serve (pid N) uses ...`: a cloud started by hand holds the data directory. Stop it, then connect again.
- `systemctl --user ... failed: Failed to connect to bus`: the shell has no systemd user session, as in a container or `su`. Log in as that user over SSH or at the console, or run `hinacode serve` under your own supervisor.
- `hinacode serve: another hinacode serve (pid N) uses ...` or `the HinaCode app (pid N) uses ...`: give this cloud its own `HINACODE_USER_DATA`.
- `hinacode serve: port 48081 is in use ...`: another cloud, or the desktop app's Settings > Connections, holds the port. Pick another with `--port`.
- `remote address is not up yet, retrying ... EADDRNOTAVAIL`: the `--host` address is not on any interface yet, as when the cloud starts at boot before Tailscale. The cloud keeps running and binds once the address comes up, retrying every 30 seconds at most.
- `routine webhook listener failed ... 48080`: the desktop app on the same machine holds the webhook port. The cloud keeps running; only its webhooks are off.
- Phone cannot connect: use the Tailscale URL the daemon printed, and confirm both devices are on the same tailnet and the firewall allows the port. The transport is plain WebSocket, encrypted by Tailscale or your LAN only.
- Lost the pairing URL: run `hinacode pair` with the same `HINACODE_USER_DATA`. It prints the same token without a restart. Restart with `--rotate-token` only when a token may have leaked, since every client must pair again.
- Secrets on a cloud are stored as plaintext in its database, since a headless machine has no keyring to unlock without a password. The data directory is created `0700`; its permissions are the protection. A cloud that an older release ran on macOS sealed its secrets with Chromium's mock key, logs `secret remote.token was sealed under another key`, and prints a new pairing URL. Pair its clients again.
