# boat.dev sandboxes as machines

Status: Building
Date: 2026-11-07

## Problem

A developer without an always-on box has nowhere to run `hinacode serve`. They have a boat.dev account, which rents Ubuntu VMs by the second, and boat already puts their GitHub login, secrets and Claude and Codex logins into every sandbox. Turning one into a HinaCode machine today means a shell in the sandbox, an npm install, a systemd unit, a public URL and a pasted pairing link.

Often the developer does not want a machine at all, only a clean box for one task: start a thread on a fresh sandbox, let the agent work, and stop paying when the work is settled.

## User flow

1. Settings > Environments, **Add a boat.dev machine**. Without a boat key, the form asks for one first (the same `boat.apiKey` secret Tiny VM uses).
2. Pick a sandbox: **New sandbox**, or one already in the account.
3. A new sandbox takes the options of boat's own create dialog: size, a saved snapshot or `bsh_` share code to start from, the boat environment (which decides the GitHub access, secrets and agent logins it receives), auto-stop hours or never, no env, snapshots off, monitoring off, and a setup script.
4. **Create** (or **Connect** for an existing sandbox). The button reads `Setting up…` for the minute it takes. The machine then appears in the list like any paired cloud, and the form offers `Add a project on <name>`.
5. When boat stops the sandbox, the machine shows offline. Connecting the same sandbox again resumes it and converges on the same row.

A sandbox for one thread:

1. In a new thread, the heading reads `What do you want to work on <project> in <machine>?`. The machine menu adds **New boat sandbox…** for a project with a GitHub `origin`.
2. The dialog takes the same spec as above, with auto-stop at 8 hours as a backstop. **Create** reads `Setting up…` until the sandbox runs HinaCode and holds a clone of the repository, then the draft moves there with its text.
3. Send. The thread runs on the sandbox like on any machine.
4. Settling the thread, or archiving it, stops the sandbox once every started thread on it is settled or archived. The disk stays as boat's snapshot.
5. Sending to the thread again, or reopening it, resumes the sandbox. The message waits in the outbox and goes out once the machine reconnects, about 20 s later.

## Design

`src/main/services/boat/BoatMachines.ts` is one service behind three desktop-only rpc methods routed to the client:

| rpc                      | Does                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `boatMachines.options`   | Sandboxes, environments and ready saved snapshots in the account, for the form                           |
| `boatMachines.connect`   | `{ sandbox: { id } }` or `{ sandbox: { create } }`, answers the added `Environment`                      |
| `boatMachines.forThread` | `{ repository, projectName, setupScript, create }`, answers the project cloned on the new thread machine |

Connect converges from any state:

1. Create (`POST /sandboxes` with the form's options and the label `hinacode=machine`), or resume a stopped sandbox keeping its auto-stop, then wait for ready.
2. One exec runs the machine script (`boat/machineScript.ts`): `npm install -g hinacode` when missing, a system unit `hinacode.service` running `bash -lc "exec hinacode serve --host 127.0.0.1"`, `systemctl enable --now`, wait for the port, then `hinacode pair`. The login shell is what gives the daemon boat's environment (`CLAUDE_CODE_OAUTH_TOKEN`, the GitHub token, `BOAT_ID`). An enabled system unit starts again after every resume.
3. `POST /sandboxes/{id}/host` for port 48081 with `localhost: true` and `public: true` answers `https://<subdomain>-48081.on.boat.dev`. The boat agent relays that URL to the loopback listener.
4. The token from `hinacode pair`, with the hosted hostname as `relay` and as the one host on port 443, becomes a pairing URL for `Environments.add`. The cloud's own id keys the row, so connecting again updates it.

Reachability. The desktop dials `wss://<hostname>/remote` as the relay route, the same path a Cloudflare tunnel takes. The direct route, plain `ws://<hostname>:443`, gets an HTTP 400 from boat's edge in about 0.2 s, so it never holds up a connect. Port 48081 on the hostname is not answered at all, and a direct dial there would wait out the 10 s probe.

The cloud does not know its boat hostname, so its `ready` frame names no relay. `Environments` used to clear the stored relay on such a `ready`, which left a boat machine dialing only the dead direct route after its first reconnect. A `ready` that arrives through the relay now keeps the stored relay, because that relay just carried the session. A cloud that unlinked its Cloudflare tunnel is reached directly, so its relay is still cleared.

Trust. The hosted URL is public, like a Cloudflare tunnel hostname: HinaCode's pairing token authenticates every connection, and boat's own `_token` would need a cookie that the phone's WebSocket cannot send. The daemon listens on loopback only, so the sandbox's public IP does not expose it. The boat key stays in main. Every boat response is schema-decoded in `Boat.ts`, and the pairing URL goes through `parsePairingUrl` as a pasted one does.

### Thread machines

`forThread` is connect with the label `hinacode=thread`, then `projects.clone` forwarded to the new machine into `~/<repository name>`. A repository a boat environment already cloned there is reused. The renderer moves the draft to the answered project with the existing `moveDraft`.

The desktop owns the lifecycle, because it holds the boat key and sees every machine. `Environments.hook` gives it three signals:

- `pushed`: a cloud's push, before it reaches the window. A `thread.updated` that is settled or archived covers what the cloud settles itself, such as a merged pull request.
- `answered`: a forwarded call answered. `threads.settle` and `threads.archive` answer without a push, so a settle from the desktop shows up here.
- `offlineMutation`: a mutation queued for a cloud that is not connected. Reads do not count, so opening a settled thread does not start the sandbox.

On either end signal, `BoatMachines` asks the machine for `threads.list` and stops the sandbox when every thread is a draft, archived or settled. It decodes only `status` and `settledAt`, because the cloud may run an older release whose threads do not match this desktop's schema. On `offlineMutation` it resumes the sandbox and calls `Environments.reconnect`. The environment maps to its sandbox by the boat subdomain in the hosted hostname, and only sandboxes labelled `hinacode=thread` stop or wake on their own. A machine added in Settings is left alone.

### Developing against a boat machine

`HINACODE_BOAT_PACKAGE=/path/to/hinacode-x.y.z.tgz` (made with `pnpm build:server`, `node scripts/stage-server-package.ts <dir>` and `npm pack`) makes connect upload that tarball and install it instead of `latest`, with `HINACODE_SERVE_AUTO_UPDATE=0` in the unit so the cloud keeps it.

## Out of scope

- SSH. The commands API runs the script, so HinaCode manages no keys.
- Starting, stopping or deleting the sandbox from the machine row. Connect again resumes it; the boat dashboard stops and deletes it.
- Deleting a thread's sandbox when the thread is deleted. Its snapshot stays for boat's 14 days.
- Stopping while the desktop is closed. The auto-stop hours are the backstop.
- Reading a stopped thread's transcript. Reads wait for the machine like any offline cloud; send or reopen to wake it.
- A project that is a subfolder of its repository. The thread machine clones the whole repository and works at its root.
- Pinning the cloud to the desktop's version. The cloud installs `latest` and updates itself like any npm cloud.

## Verification

- `Boat.test.ts`: the new endpoints against the fake boat server.
- `BoatMachines.test.ts`: options and connect against the fake boat server: a new sandbox with the form's options, a stopped one resumed with its auto-stop kept, the pairing URL built from the hosted hostname, and the script's error output when HinaCode does not start. For thread machines: the label and the forwarded clone, a project without a repository refused, a stop only once every thread is settled (from a push and from a settle answer), a Settings machine never stopped, and a queued mutation resuming the sandbox.
- `Environments.integration.test.ts`: a `ready` without a relay keeps the relay it came through, and the hooks hear pushes, answers and mutations made while offline, but not reads.
- By hand on 2026-11-07 against the live API with `small` sandboxes: create, install, `hinacode pair`, and a WebSocket through the hosted URL answering `ready` and `projects.list`. Then through the desktop form with `verify-hinacode`: connecting an existing sandbox, creating a new one, and reconnecting both after an app restart. The daemon's environment carried `CLAUDE_CODE_OAUTH_TOKEN` and `claude auth status` reported signed in. A thread machine for a clone of `octocat/Hello-World`: the draft moved with its text, the turn ran on the sandbox, settling stopped it, and a follow-up resumed it and was answered, with both turns in the transcript.
