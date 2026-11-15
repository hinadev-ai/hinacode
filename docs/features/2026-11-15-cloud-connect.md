# One command for an always-on cloud

Status: Shipped
Date: 2026-11-15

## Problem

A developer who wants a cloud on a home server wants it running all the time. Today they install Node, run `npx hinacode serve`, and then hand-write a launchd plist or systemd unit from the hints in `docs/operations/cloud.md`. They need the right `PATH`, `KeepAlive` or `Restart=`, linger and a log file. Most stop at a foreground process in a terminal that dies with the SSH session.

## User flow

1. On the server: `curl -fsSL https://hinacode.app/install.sh | bash`.
2. It downloads the executable for this machine, links `~/.local/bin/hinacode`, and runs `hinacode connect`.
3. Connect prints where the service and its log live, then the usual pairing block. The developer scans the QR code or pastes the desktop URL.
4. Later, the same curl command updates it, and `hinacode disconnect` removes the service.

## Design

- `site/public/install.sh` is served at `https://hinacode.app/install.sh`. It picks the release archive from `uname`, unpacks it into `~/.local/share/hinacode/versions/<version>/`, swaps the link, runs `connect`, then deletes older versions. The whole script sits in `main`, so a cut-off download runs nothing. `HINACODE_RELEASE_URL` points it at another release.
- `src/cli/service.ts` holds one `ServiceManager` per platform: the unit path, the log path, a renderer, and the `stop`, `reload`, `start` and `disable` steps. macOS gets a launchd agent in the GUI domain, Linux a systemd user unit plus `loginctl enable-linger`. Every other platform is refused.
- The unit runs the program that ran `connect`, which is the executable itself or `node` with the installed script. Under `npx` it refuses, because npm may clear its cache under a running service.
- Connect stops an existing service first, then refuses if another `hinacode serve` still holds the data directory. It waits up to 30 s for `daemon.pid`, an enabled listener and the token the daemon creates, then prints the pairing through the same code as `hinacode pair`. That read path never creates a token, so connect cannot print one the daemon then replaces. The service writes no token to its log: `serve` prints the pairing block only to a terminal, and connect creates the log directory `0700` and the log `0600`. On timeout it prints the end of the log.

## Out of scope

- Self-update for the executable. It updates when the developer runs the install command again, as before.
- Linking the relay from connect. `hinacode serve --relay` waits for a browser approval, which a service has no terminal for.
- Windows. The cloud executable does not ship for it.

## Verification

- `src/cli/service.test.ts` covers the program choice, the npx refusal, and quoting in both unit formats.
- By hand, on an Ubuntu VM with no Node 26: the curl command installed and paired, `kill -9` restarted the service, connect again and disconnect worked, a foreground `hinacode serve` made connect refuse, and the cloud listened again after a reboot.
