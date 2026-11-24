# Run a hinacode cloud on a home server

A cloud is `hinacode serve`: the app's services as a plain Node program, with no window and no Electron. It has its own database, and agents and worktrees on that machine, reachable by the phone and by the desktop's environments. Design: `docs/features/2026-10-14-remote-clouds.md`.

## Start it

Node 24.22.1 or newer (26.12.1 or newer on Node 26):

```sh
npx hinacode serve
```

Without Node, download `hinacode-<platform>-<arch>.tar.gz` for `linux-x64`, `linux-arm64` or `darwin-arm64` from the [latest release](https://github.com/hinadev-ai/hinacode/releases/latest), unpack it anywhere and run the executable inside. Keep `node_modules/` next to it. On Linux it needs glibc 2.28 and `libatomic.so.1` (`apt install libatomic1` in a minimal image), the same as Node. It does not update itself; unpack the next release over it and restart.

```sh
tar -xzf hinacode-linux-x64.tar.gz && ./hinacode/hinacode serve
```

From a checkout, `pnpm serve` builds and runs the same daemon, and `pnpm build:exe` builds the archive for this machine into `dist-exe/`.

The daemon keeps its data in `HINACODE_USER_DATA`, default `~/.hinacode-cloud`, and prints the pairing block: a phone URL for its address and a QR code to scan in the mobile app, then the URL to add under Settings > Connections on the desktop. It listens on `--host`, else the address it used last, else `private`. `private` answers on the LAN and Tailscale and closes any connection with a public address on either end, so a phone at home connects with no flags. Anyone on the same network can reach the port, but every session is encrypted to the cloud's key, and only a device the cloud trusts gets in. Pass one address, such as a Tailscale address, to keep other networks out entirely, or `--host 127.0.0.1 --relay` to be reached only through the relay. A machine that already stored an address keeps it until you pass `--host private`. `0.0.0.0` and `::` are refused. `hinacode pair` prints the block again, with the current pairing secret, whether the daemon runs or not. The secret pairs one device, then the cloud replaces it. The data directory holds `hinacode.sqlite`, attachments, and the cloud's key, pairing secret and trusted devices inside the database. A desktop app and a cloud refuse to share one directory, and so do two clouds. The daemon spots a desktop by the `SingletonLock` in the directory's `chromium/`.

Options, flags first, then environment, then stored settings:

| Flag                    | Environment                      | Meaning                                                                                             |
| ----------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `--port <n>`            | `HINACODE_SERVE_PORT`            | Listener port, default 48081                                                                        |
| `--host <host>`         | `HINACODE_SERVE_HOST`            | One bind address or `private`, the default                                                          |
| `--reset-pairing`       | `HINACODE_SERVE_RESET_PAIRING=1` | Replace the cloud's key and pairing secret at boot, remove every device and disconnect every client |
| `--relay`, `--no-relay` | `HINACODE_SERVE_RELAY`           | Link the cloud to the HinaCode relay, or unlink it                                                  |
|                         | `HINACODE_SERVE_AUTO_UPDATE=0`   | Do not install new releases on its own when idle                                                    |
|                         | `HINACODE_SERVE_LOG`             | File the service manager writes output to, kept under 10 MB                                         |
|                         | `HINACODE_MEMORY_GUARD=0`        | Do not stop threads when the machine runs short of memory                                           |

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

- Install it once instead of resolving it on every boot: `npm install -g --allow-scripts=node-pty hinacode`, then run `hinacode serve`. npm 11 skips node-pty's install script without that flag, and the terminal then fails to start.
- A cloud installed with `npm install -g` updates itself: it checks npm every 4 hours and installs a new release once no turn, queued message, setup script or terminal is running. To update right away, use Settings, Connections, `Update all` on the desktop. The cloud installs the release into the same npm prefix and restarts itself under the same pid, so a systemd or launchd service keeps running it. A cloud started with `npx` or from a checkout does not update itself. By hand, run `npm install -g --allow-scripts=node-pty hinacode@latest` and restart.
- Run it as a service: `hinacode service install` writes a user service for the `hinacode` you ran it with, starts it at login, and restarts it when it stops. Run `hinacode serve` in a terminal once first to pair or link the relay, since the service runs with the settings stored in the data directory. It carries the PATH of the shell you install from and `HINACODE_USER_DATA`, so install from a shell that finds `node`, `claude`, `codex` and `gh`. Running it again rewrites the service and restarts it. `hinacode service uninstall` removes it and keeps the data. It refuses an `npx` cache path, and waits for, then refuses, another `hinacode serve` on the same data directory.
  - macOS: `~/Library/LaunchAgents/ai.hinacode.serve.plist`, logging to `~/Library/Logs/hinacode/serve.log`. The cloud keeps that file under 10 MB: past it, it copies the file to `serve.log.1` and empties it in place, checking at boot and every 10 minutes.
  - Linux: `~/.config/systemd/user/hinacode.service`, logging to the journal (`journalctl --user -u hinacode -f`). Run `loginctl enable-linger $USER` so it starts at boot without a login; the install prints this when it is off. `SIGTERM` is handled: running turns persist before exit, at most 5 seconds.
- Agent logins belong to the cloud: run `claude login`, `codex login`, `muse login` and `gh auth login` in a shell on that machine, once. hinacode never signs in for you.
- A firewall must let the listener port in. With `ufw`, open it on the Tailscale interface only: `sudo ufw allow in on tailscale0 to any port 48081 proto tcp`.

## Troubleshooting

- `hinacode serve: another hinacode serve (pid N) uses ...` or `the HinaCode app (pid N) uses ...`: give this cloud its own `HINACODE_USER_DATA`.
- `hinacode serve: port 48081 is in use ...`: another cloud, or the desktop app's Settings > Connections, holds the port. Pick another with `--port`.
- `remote address is not up yet, retrying ... EADDRNOTAVAIL`: the `--host` address is not on any interface yet, as when the cloud starts at boot before Tailscale. The cloud keeps running and binds once the address comes up, retrying every 30 seconds at most.
- `routine webhook listener failed ... 48080`: the desktop app on the same machine holds the webhook port. The cloud keeps running; only its webhooks are off.
- Phone cannot connect: use the Tailscale URL the daemon printed, and confirm both devices are on the same tailnet and the firewall allows the port. The phone also needs the cloud's current pairing URL, since the URL pins the cloud's key.
- A turn failed with `Stopped to free memory ...`: the machine was about to run out, and the memory guard stopped the thread whose processes held the most (`docs/features/2026-11-13-memory-guard.md`). Send the thread a message to resume it, and run fewer heavy threads at once. The log has one `memory guard stopped thread` line per stop, with the free memory and the stall it saw.
- `Failed with result 'oom-kill'` in `systemctl --user status`: the kernel or `systemd-oomd` killed the cloud before the guard could act, or the guard is off. Every running turn is lost. `journalctl -u systemd-oomd` and `journalctl -k` name the killer.
- Lost the pairing URL: run `hinacode pair` with the same `HINACODE_USER_DATA`. It prints the current secret without a restart. Restart with `--reset-pairing` only when the cloud's key may have leaked, since every client must pair again.
- A device learned through the relay waits for approval, and the log says `A device is waiting for approval`. Run `hinacode devices approve <code>` with the code the device shows. `hinacode devices` lists the trusted devices, and `hinacode devices remove <name>` removes a lost one and ends its sessions.
- Secrets on a cloud are stored as plaintext in its database, since a headless machine has no keyring to unlock without a password. The data directory is created `0700`; its permissions are the protection. A cloud that an older release ran on macOS sealed its secrets with Chromium's mock key, logs `secret remote.hostKey was sealed under another key`, and prints a new pairing URL. Pair its clients again.
