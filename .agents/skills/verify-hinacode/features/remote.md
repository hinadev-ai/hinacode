# Remote mode

A user can control hinacode from elsewhere in two ways, both on Settings > `Connections`. Its Remote section turns on a listener that phones, browsers and other desktops pair with, end to end encrypted to the machine's host key, and optionally a relay that reaches it from any network. Its environments section pairs this desktop with a cloud, a machine running `hinacode serve`; the cloud's projects and threads then show in the sidebar with a cloud icon, and their agents run on that machine. The machine-scoped settings pages and the Remote section then edit either machine through the `Editing settings for` picker. No agent turn is needed.

## Automated coverage

No scenario in `e2e/features` covers remote mode. `src/main/ipc.integration.test.ts` (`remote mode`, `remote mode under a test clock`) covers phone rpc and pushes, port conflicts, and turning the listener off and on. `src/main/services/Environments.integration.test.ts` (`desktop environments`) covers pairing a cloud, pinned host keys, the approval code, refusing a bad URL, merged lists, routing calls to the cloud that owns a thread, staged files and pushes.

## Sub-features

- `remote-listener` `Allow remote control` starts the listener on `Remote listener` and `Port`; the status reads `Listening on <host>:<port>`.
- `remote-pairing` `Pair a phone` shows the addresses, a QR code, and the `Pairing URL` with `Copy pairing URL`. The URL carries the host `key` and a one-time `secret`: once a device enrolls with it, the machine replaces the secret and the QR code and URL change on their own. `Reset pairing` asks in `Reset pairing?` first, then gives the machine a new key and removes every device.
- `remote-devices` `Devices` lists each trusted device with `Added <time>`, `Connected` or `Last seen <time>`, and a status dot. `Remove` (`Remove <name>`) asks in `Remove <name>?` and ends its sessions. `Approve a device` takes the `XXX-XXX` code a waiting device shows; `Approve` reports `<name> can now control this machine.` or `No waiting device shows that code.`, and `N device(s) are waiting` shows while requests wait. Waiting devices are never listed by name.
- `device-notifications` a device enrolling raises `<name> was paired with this machine`, and a device waiting for a code raises `A device is waiting for approval`, as a toast when the window has focus and an OS notification otherwise. Clicking opens Settings > `Connections`.
- `approval-notice` a cloud in `approval` status shows `Enter <code> on <name>, in Settings, Connections.` on the home page (and in its threads), then `Did <name> accept the code?` with `Yes` and `No` once the machine accepted it.
- `relay` `Turn on relay` links the machine to the user's HinaCode account through a browser sign-in.
- `environment-add` a `Pairing URL` from `hinacode serve` adds a cloud whose card reads `Connected`.
- `cloud-sidebar` the cloud's projects and threads show in the sidebar with a cloud icon named `On <cloud>`; Details shows `On <cloud>` and the cloud's ports.
- `settings-picker` once a cloud exists, `Editing settings for` shows on `Providers`, `Worktrees`, `Integrations`, `Routines` and `Experimental` and switches them to it. The Remote section on `Connections` has the same picker (`[aria-labelledby=remote-environment]`); for a cloud it shows the status lines and `Remote listener` only, with no switch, `Port`, `Pair a phone` or `Apps`.
- `environment-rename` `Rename` on a cloud's card opens `Rename <name>`; `Save` renames it in the sidebar, the draft heading and Details at once, and the name survives a relay sync and a restart.
- `environment-remove` `Remove` with confirmation in `Remove <name>?` forgets the cloud.

## How to get to it (user POV)

- Settings > `Connections`.
- The cloud prints one pairing URL per host on start under `Pair a desktop:`; `hinacode pair` prints them again.

## Driving it with agent-browser

Preconditions:

- Instance launched and doctor passes. `pnpm build:server` built `out/server/daemon.js` (`pnpm build` does not). Viewport set as in `../SKILL.md`.
- `ab() { agent-browser --session kkv-$PORT-remote --cdp $PORT "$@"; }`.
- `CLOUD=/tmp/kk-cloud-$PORT`, `CPORT=$((30000 + PORT))`, `RPORT=$((31000 + PORT))`, all free.

- **Listener and pairing.** Open Settings > `Connections`. `ab click '#remote-bind-host'`, `ab wait '[role=option]'`, `ab find role option click --name "This machine only (127.0.0.1)" --exact`, `ab fill '#remote-port' $RPORT`, `ab click 'form:has(#remote-port) button[type=submit]'`, then `ab find role switch click --name "Allow remote control" --exact`. `#remote-enabled` is a hidden 1px input, so clicking it hits the header. The status reads `Listening on 127.0.0.1:<RPORT>` and `Pair a phone` appears. `$S/rpc.ts $PORT remote.status` shows `"listening": true`; `remote.pairing` shows the `key` and `secret` that `#remote-pair-url` contains. Screenshot `remote-01-pairing.png`. Click `Reset pairing`, confirm in `Reset pairing?`; `remote.pairing` returns a new `key` and `secret`, and `remote.devices` is empty.
- **Start a cloud.** `mkdir -p $CLOUD && $S/seed-repo.sh $CLOUD/repo`, then `source $S/proc.sh; (HINACODE_USER_DATA=$CLOUD HINACODE_SERVE_AUTO_UPDATE=0 new_session node out/server/cli.js serve --host 127.0.0.1 --port $CPORT --relay off > $CLOUD/serve.log 2>&1 < /dev/null &)`. `out/server/daemon.js` is a library chunk and exits at once without output. Wait until the log has `Pair a phone:`; the pairing URL is `URL=$(grep -o 'hinacode://connect[^ ]*' $CLOUD/serve.log | head -1)`.
- **Add the environment.** On `Connections`, `ab fill '#environment-name' kk-cloud`, `ab fill '#environment-pairing-url' "$URL"`, `ab find role button click --name "Add" --exact`. `Added kk-cloud.` shows and the card reads `Connected`. Screenshot `remote-02-environment.png`. `$S/rpc.ts $PORT environments.list` lists it.
- **Cloud project in the sidebar.** Click `Add a project on kk-cloud` (shown right after `Add` succeeds). The dialog's `Where` reads `kk-cloud`. Fill `Folder or GitHub repository` with `$CLOUD/repo`, but fill `Name` with `ab fill '[role=dialog] #project-name' <name>`: `find label "Name"` fills `#environment-name` behind the dialog. Submit with `ab click '[role=dialog] button[type=submit]'`. The draft asks `What do you want to do in repo on kk-cloud?`, the sidebar gains the project with the cloud icon (hidden label `On kk-cloud`), and Details reads `On kk-cloud`. Screenshot `remote-03-cloud-sidebar.png`.
- **Settings picker.** `Editing settings for` now shows on `Providers` and the other machine-scoped pages. Pick `kk-cloud`; `Providers` shows the cloud's settings.
- **A cloud's listener.** On `Connections`, pick `kk-cloud` in the Remote section's picker. `#remote-bind-host` reads the cloud's `This machine only (127.0.0.1)`. Pick `Local network and Tailscale`: the cloud has no relay, so `Change the listener on kk-cloud?` opens first. `Change listener` saves it, the cloud's log gains `remote listening private:<CPORT>`, and the card returns to `Connected` after a moment offline. This opens `$CPORT` on the LAN, so set it back to `This machine only (127.0.0.1)` when done.
- **Seeding the cloud through rpc.** `$S/rpc.ts` always calls this machine. To create a project or thread on the cloud, pass its environment id as the third argument from the page: `ab eval 'window.hinacode.rpc("projects.create", {...}, "<environment id>")'`. The answer is an envelope, `{ result }` or `{ error }`.
- **Teardown.** `source $S/proc.sh; kill $(port_holders $CPORT)`, wait until `port_in_use $CPORT` fails, then `rm -rf $CLOUD`. The card turns `Offline` before you remove it.
- **Devices and approval between two desktops.** Launch a second instance B. In A turn on the listener as above and copy `#remote-pair-url`. In B, add an environment with that URL: A's `Devices` gains B's device and A raises `<name> was paired with this machine`, and A's QR code changes. For the code path, give B the URL without `&secret=...`: B's card reads `Enter <code> on <A>, in Settings, Connections.`, A shows `1 device is waiting`; type the code into A's `Approve a device` and B's card turns `Connected`; only a machine learned through the relay also asks `Did <A> accept the code?` on B. `Remove <name>` on A turns B's card to `<A> no longer accepts this device. Pair it again.` Every device of one checkout is named after `os.hostname()`; for screenshots launch B with `NODE_OPTIONS="--require <file>"` where the file sets `require("node:os").hostname = () => "studio-b"`, so the real hostname stays out of them.

## Gotchas

- The `Remote listener` starts on `Local network and Tailscale`, port 48081, so `Allow remote control` works at once. The other choices are each network address and `This machine only (127.0.0.1)`; there is no `0.0.0.0`. Use loopback and a per-instance port, because the default answers on the LAN and can collide with a daemon on the same port.
- `Port` needs `Save`; the switch and the listener select apply at once.
- `Turn on relay` downloads its own `cloudflared` but needs a real HinaCode account sign-in in a browser CDP cannot reach. Report `relay` as not driven unless the user asked for it.
- The cloud uses its own `HINACODE_USER_DATA`; without it the daemon writes to `~/.hinacode-cloud`. `cleanup.sh` does not know about it, so kill it by pid and delete its dir yourself. The cloud's log still says `Settings > Environments > Add environment`; the page is now `Connections`.
- Pairing URLs and `remote.pairing` contain the one-time pairing secret. Do not paste them into a PR or a screenshot that leaves the machine.
