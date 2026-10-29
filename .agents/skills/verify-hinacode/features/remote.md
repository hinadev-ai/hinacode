# Remote mode

A user can control hinacode from elsewhere in two ways. Settings > Remote turns on a token-guarded listener that the phone app pairs with, and optionally a relay that reaches it from any network. Settings > Environments pairs this desktop with a cloud, a machine running `hinacode serve`; the cloud's projects and threads then show in the sidebar with a cloud icon, and their agents run on that machine. Settings then edits either machine through the `Editing settings for` picker. No agent turn is needed.

## Automated coverage

No scenario in `e2e/features` covers remote mode. `src/main/ipc.integration.test.ts` (`remote mode`, `remote mode under a test clock`) covers the sealed handshake, token checks and rotation, phone rpc and pushes, port conflicts, and turning the listener off and on. `src/main/services/Environments.integration.test.ts` (`desktop environments`) covers pairing a cloud, refusing a bad URL or token, merged lists, routing calls to the cloud that owns a thread, staged files and pushes.

## Sub-features

- `remote-listener` `Allow remote control` starts the listener on `Remote listener` and `Port`; the status reads `Listening on <host>:<port>`.
- `remote-pairing` `Pair a phone` shows the addresses, a QR code, the `Pairing URL` with `Copy pairing URL`, and `Rotate token`, which issues a new token at once without a confirm and disconnects paired phones.
- `relay` `Turn on relay` links the machine to the user's HinaCode account through a browser sign-in.
- `environment-add` a `Pairing URL` from `hinacode serve` adds a cloud whose card reads `Connected`.
- `cloud-sidebar` the cloud's projects and threads show in the sidebar with a cloud icon named `On <cloud>`.
- `settings-picker` once a cloud exists, `Editing settings for` switches the machine-scoped pages to it; `Remote` is hidden for a cloud.
- `environment-remove` `Remove` with confirmation in `Remove <name>?` forgets the cloud.

## How to get to it (user POV)

- Settings > `Remote` (under `This machine`), and Settings > `Environments` (under `App`).
- The cloud prints its pairing URLs on start under `Pair a desktop:`; `hinacode pair` prints them again.

## Driving it with agent-browser

Preconditions:

- Instance launched and doctor passes, built with `pnpm build` so `out/main/daemon.js` exists. Viewport set as in `../SKILL.md`.
- `AB="agent-browser --session kkv-$PORT-remote"`, connected.
- `CLOUD=/tmp/kk-cloud-$PORT`, `CPORT=$((30000 + PORT))`, `RPORT=$((31000 + PORT))`, all free.

- **Listener and pairing.** Open Settings > `Remote`. Set `Remote listener` to `This machine only (127.0.0.1)`, `$AB fill '#remote-port' $RPORT`, click `Save`, then turn on `Allow remote control`. The status reads `Listening on 127.0.0.1:<RPORT>` and `Pair a phone` appears. `$S/rpc.ts $PORT remote.status` shows `"listening": true`; `remote.pairing` shows the token that `#remote-pair-url` contains. Screenshot `remote-01-pairing.png`. Click `Rotate token`; no dialog opens, and `remote.pairing` returns a new token.
- **Start a cloud.** `mkdir -p $CLOUD && $S/seed-repo.sh $CLOUD/repo`, then `HINACODE_USER_DATA=$CLOUD HINACODE_SERVE_AUTO_UPDATE=0 setsid node out/main/daemon.js serve --host 127.0.0.1 --port $CPORT --relay off > $CLOUD/serve.log 2>&1 & echo $! > $CLOUD/serve.pid`. Wait until the log has `Pair a desktop:`; the line after it is the URL: `URL=$(grep -A1 'Pair a desktop' $CLOUD/serve.log | tail -1 | tr -d ' ')`.
- **Add the environment.** Settings > `Environments`, `$AB fill '#environment-name' kk-cloud`, `$AB fill '#environment-pairing-url' "$URL"`, click `Add`. `Connected to kk-cloud.` shows and the card reads `Connected`. Screenshot `remote-02-environment.png`. `$S/rpc.ts $PORT environments.list` lists it.
- **Cloud project in the sidebar.** Click `Add a project on kk-cloud`, fill `Folder or GitHub repository` with `$CLOUD/repo`, `Add project`. The sidebar gains the project with the cloud icon, whose hidden label reads `On kk-cloud`. Screenshot `remote-03-cloud-sidebar.png`.
- **Settings picker.** `Editing settings for` now shows above the machine pages. Pick `kk-cloud`; `Remote` leaves the nav, and `Models` shows the cloud's settings.
- **Teardown.** `kill $(cat $CLOUD/serve.pid)`, wait until `ss -ltn "sport = :$CPORT"` is empty, then `rm -rf $CLOUD`. The card turns `Offline` before you remove it.

## Gotchas

- The default `Remote listener` is `All interfaces (0.0.0.0)` on port 48081, which exposes the listener on the LAN and Tailscale. Set loopback and a per-instance port before turning it on.
- `Port` needs `Save`; the switch and the listener select apply at once.
- `Turn on relay` needs `cloudflared` and a real HinaCode account sign-in in a browser CDP cannot reach. Report `relay` as not driven unless the user asked for it.
- The cloud uses its own `HINACODE_USER_DATA`; without it the daemon writes to `~/.hinacode-cloud`. `cleanup.sh` does not know about it, so kill it by pid and delete its dir yourself.
- Pairing URLs and `remote.pairing` contain the access token. Do not paste them into a PR or a screenshot that leaves the machine.
