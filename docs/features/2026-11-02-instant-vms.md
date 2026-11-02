# Instant VMs

Status: Building (prototype)
Date: 2026-11-02

## Problem

`create_thread` with `machine` hands work to another of the user's machines, but only to one that already exists, is paired and has the project. An agent that wants to fan work out, or keep a risky task off the developer's machines, has to stop and ask for a machine.

boat.dev already backs Tiny VM. A boat sandbox is an Ubuntu VM with Node, both agent CLIs and an HTTPS port proxy that carries WebSockets, which is everything `hinacode serve` needs.

## User flow

1. In Settings > Experimental > Instant VMs, add the boat API key and the VM environment, such as `CLAUDE_CODE_OAUTH_TOKEN=… GH_TOKEN=…`.
2. An agent calls `create_thread` with `machine: "new"`. The call takes a few minutes.
3. The new VM appears as another machine, `boat-1a2b3c4d`, with the repository cloned, and the thread starts its first turn there. It shows in the sidebar like any cloud thread.
4. Settings > Connections > Remove on that machine deletes the sandbox. A forgotten one archives itself after boat's two-hour TTL.

## Design

`services/instantVm/InstantVms.ts`, `provision(repository)`:

1. `POST /sandboxes` with the size setting, the VM environment secret and the label `hinacode-instant-vm`.
2. `npm install -g hinacode`. `HINACODE_INSTANT_VM_PACKAGE` points at a local tarball to install instead, for running a branch.
3. Start `hinacode serve` bound to `127.0.0.1:47821` as a detached boat command, then poll `hinacode pair` for its pairing URL.
4. `POST /sandboxes/{id}/host` with `public` and `localhost` gives `https://<sandbox>-47821.on.boat.dev`. HinaCode's own token and challenge protect the socket, so the boat cookie gate is not needed.
5. Pair it through `Environments.add` as host `<sandbox>-47821.on.boat.dev` on port 443. A remote on port 443 is dialed over TLS (`wss://<host>/remote`), since nothing serves plain WebSockets there.
6. `projects.clone` on the new machine, then `create_thread` continues as for any other machine.
7. When this machine has a device hub with a relay hostname, the VM links the same hub, so an agent in a boat VM can drive the Mac's simulator.

`<userData>/instant-vms.json` maps environment id to sandbox id. It is a cache like `boat-sandboxes.json`. Losing it leaves the sandbox to its TTL. `environments.remove` calls `release`, which deletes the sandbox.

## Out of scope

- Starting a VM from a cloud thread. The VM pairs with the machine that provisioned it, so only the desktop's threads see it.
- A UI to start a VM by hand, progress while it provisions, and keeping a stopped VM to resume.
- Copying the developer's own agent logins into the VM. The environment secret is explicit.

## Verification

One live run against boat.dev: `create_thread` with `machine: "new"` from a desktop thread, the VM in the sidebar, the turn running there, then Remove deleting the sandbox.
