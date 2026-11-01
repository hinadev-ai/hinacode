# Remote mode

A user can control hinacode from elsewhere in two ways, both on Settings > `Connections`. Its Remote section turns on a token-guarded listener that the phone app pairs with, and optionally a relay that reaches it from any network. Its environments section pairs this desktop with a cloud, a machine running `hinacode serve`; the cloud's projects and threads then show in the sidebar with a cloud icon, and their agents run on that machine. The machine-scoped settings pages then edit either machine through the `Editing settings for` picker. No agent turn is needed.

## Automated coverage

No scenario in `e2e/features` covers remote mode. `src/main/ipc.integration.test.ts` (`remote mode`, `remote mode under a test clock`) covers the sealed handshake, token checks and rotation, phone rpc and pushes, port conflicts, and turning the listener off and on. `src/main/services/Environments.integration.test.ts` (`desktop environments`) covers pairing a cloud, refusing a bad URL or token, merged lists, routing calls to the cloud that owns a thread, staged files and pushes.

## Sub-features

- `remote-listener` `Allow remote control` starts the listener on `Remote listener` and `Port`; the status reads `Listening on <host>:<port>`.
- `remote-pairing` `Pair a phone` shows the addresses, a QR code, the `Pairing URL` with `Copy pairing URL`, and `Rotate token`, which issues a new token at once without a confirm and disconnects paired phones.
- `relay` `Turn on relay` links the machine to the user's HinaCode account through a browser sign-in.
- `environment-add` a `Pairing URL` from `hinacode serve` adds a cloud whose card reads `Connected`.
- `cloud-sidebar` the cloud's projects and threads show in the sidebar with a cloud icon named `On <cloud>`; Details shows `On <cloud>` and the cloud's ports.
- `settings-picker` once a cloud exists, `Editing settings for` shows on `Providers`, `Worktrees`, `Integrations`, `Automations` and `Experimental` and switches them to it. `Connections` has no picker and always edits this machine.
- `environment-remove` `Remove` with confirmation in `Remove <name>?` forgets the cloud.

## How to get to it (user POV)

- Settings > `Connections`.
- The cloud prints one pairing URL per host on start under `Pair a desktop:`; `hinacode pair` prints them again.

## Driving it with agent-browser

Preconditions:

- Instance launched and doctor passes. `pnpm build:server` built `out/server/daemon.js` (`pnpm build` does not). Viewport set as in `../SKILL.md`.
- `ab() { agent-browser --session kkv-$PORT-remote --cdp $PORT "$@"; }`.
- `CLOUD=/tmp/kk-cloud-$PORT`, `CPORT=$((30000 + PORT))`, `RPORT=$((31000 + PORT))`, all free.

- **Listener and pairing.** Open Settings > `Connections`. `ab click '#remote-bind-host'`, `ab wait '[role=option]'`, `ab find role option click --name "This machine only (127.0.0.1)" --exact`, `ab fill '#remote-port' $RPORT`, `ab click 'form:has(#remote-port) button[type=submit]'`, then `ab find role switch click --name "Allow remote control" --exact`. `#remote-enabled` is a hidden 1px input, so clicking it hits the header. The status reads `Listening on 127.0.0.1:<RPORT>` and `Pair a phone` appears. `$S/rpc.ts $PORT remote.status` shows `"listening": true`; `remote.pairing` shows the token that `#remote-pair-url` contains. Screenshot `remote-01-pairing.png`. Click `Rotate token`; no dialog opens, and `remote.pairing` returns a new token.
- **Start a cloud.** `mkdir -p $CLOUD && $S/seed-repo.sh $CLOUD/repo`, then `source $S/proc.sh; (HINACODE_USER_DATA=$CLOUD HINACODE_SERVE_AUTO_UPDATE=0 new_session node out/server/daemon.js serve --host 127.0.0.1 --port $CPORT --relay off > $CLOUD/serve.log 2>&1 < /dev/null & echo $! > $CLOUD/serve.pid)`. Wait until the log has `Pair a desktop:`; the line after it is the URL: `URL=$(grep -A1 'Pair a desktop' $CLOUD/serve.log | tail -1 | tr -d ' ')`.
- **Add the environment.** On `Connections`, `ab fill '#environment-name' kk-cloud`, `ab fill '#environment-pairing-url' "$URL"`, `ab find role button click --name "Add" --exact`. `Connected to kk-cloud.` shows and the card reads `Connected`. Screenshot `remote-02-environment.png`. `$S/rpc.ts $PORT environments.list` lists it.
- **Cloud project in the sidebar.** Click `Add a project on kk-cloud` (shown right after `Add` succeeds). The dialog's `Where` reads `kk-cloud`. Fill `Folder or GitHub repository` with `$CLOUD/repo`, but fill `Name` with `ab fill '[role=dialog] #project-name' <name>`: `find label "Name"` fills `#environment-name` behind the dialog. Submit with `ab click '[role=dialog] button[type=submit]'`. The draft asks `What do you want to work on repo in kk-cloud?`, the sidebar gains the project with the cloud icon (hidden label `On kk-cloud`), and Details reads `On kk-cloud`. Screenshot `remote-03-cloud-sidebar.png`.
- **Settings picker.** `Editing settings for` now shows on `Providers` and the other machine-scoped pages. Pick `kk-cloud`; `Providers` shows the cloud's settings.
- **Teardown.** `source $S/proc.sh; signal_session TERM $(cat $CLOUD/serve.pid)`, wait until `port_in_use $CPORT` fails (kill `$(port_holders $CPORT)` if it lingers), then `rm -rf $CLOUD`. The card turns `Offline` before you remove it.

## Gotchas

- The `Remote listener` starts unset on port 48081, so `Allow remote control` stays disabled until you pick an interface (each network address, or `This machine only (127.0.0.1)`; there is no `0.0.0.0`). Use loopback and a per-instance port.
- `Port` needs `Save`; the switch and the listener select apply at once.
- `Turn on relay` downloads its own `cloudflared` but needs a real HinaCode account sign-in in a browser CDP cannot reach. Report `relay` as not driven unless the user asked for it.
- The cloud uses its own `HINACODE_USER_DATA`; without it the daemon writes to `~/.hinacode-cloud`. `cleanup.sh` does not know about it, so kill it by pid and delete its dir yourself. The cloud's log still says `Settings > Environments > Add environment`; the page is now `Connections`.
- Pairing URLs and `remote.pairing` contain the access token. Do not paste them into a PR or a screenshot that leaves the machine.
