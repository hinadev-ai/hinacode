# Device hub

Status: Building (prototype)
Date: 2026-11-02

## Problem

The Devices view streams the thread machine's own simulators. A thread on a Linux VM, a home server or a boat sandbox has no iOS simulator, because the simulator needs macOS and Xcode. The developer has a Mac mini running HinaCode on the same tailnet, but a thread on another machine cannot use it.

T3 Code solves this with SSH: the environment server opens an SSH tunnel to the Mac, installs its own device hub there and proxies a video stream. HinaCode already has an authenticated machine-to-machine connection and a simulator producer, so the Mac only needs to be another HinaCode machine.

## User flow

1. On the Mac, run HinaCode (desktop or `hinacode serve`). Its pairing URL is in Settings > Connections, or `hinacode pair` prints it.
2. On the machine that needs devices, open Settings > Experimental (on the desktop, pick that environment first), turn on Devices and paste the Mac's URL under Device hub. The row then says "Using devices from mac-mini".
3. The thread's Devices view now lists the Mac's simulators and emulators. New simulator, Attach, the live screen, control hand-over and every `device_*` agent tool work as they do locally.
4. Unlink switches back to this machine's own devices.

## Design

Two roles on one seam. `Devices` already talks to platforms through `DevicePlatformDriver` (`services/devices/platform.ts`). The hub is a remote implementation of that interface.

- **Hub side.** `DeviceHub.host` answers `deviceHost.*` rpc methods from the machine's own drivers: `list`, `boot`, `create`, `remove`, `screenshot`, `describe`, `launch`, plus a stream (`open`, `frame`, `send`, `close`). `frame` is the same newest-frame long poll as `device.frame`, so a slow link lowers the frame rate instead of queueing. A stream nobody polls for 15 s closes.
- **Client side.** `experimental.deviceHub` holds the hub's environment id. `DeviceHub.drivers` delegates each call to the hub's drivers while it is set and to the local ones otherwise. `Devices` is unchanged: thread state, control, leases, `thread_device` rows and the MCP tools keep running on the thread's machine, and only driver calls cross to the hub.
- **Linking.** `deviceHub.link({ pairingUrl })` pairs the hub as an environment of this machine (`Environments.add`) and stores its id. All three `deviceHub.*` methods are named routes, so the desktop links a cloud by naming it.
- **No second hub.** A cloud that pairs with another machine must not claim to be its hub, or that machine's cross-machine tools would ask the cloud instead of the desktop. `Environments.cloudLayer` skips the `hub` frame. The desktop keeps `Environments.layer`.

Frames cross twice when the desktop views a cloud thread that uses a hub: Mac to cloud, then cloud to desktop. Each hop is one request in flight per viewer.

## Trust boundary

`deviceHost.*` runs on any client that holds the hub's pairing token, the same trust a paired desktop or phone already has. Every payload is decoded with the contract schemas on both ends. The pairing URL crosses from the renderer to main once, in `deviceHub.link`.

## Out of scope

- Picking the hub from the machines the desktop already knows. Pasting the URL covers both cases, and `Environments.add` converges on one row.
- A hub per platform, and several hubs. One machine serves all platforms.
- Progress steps for create and boot on the hub. The view shows one step until the remote call returns.
- Video transport (ADR 0024 still holds).

## Verification

- `services/devices/DeviceHub.integration.test.ts` pairs two real runtimes over loopback. The client lists the hub's fake simulator, attaches it, reads its frames, sends a touch that the hub's driver records, does not become the hub's hub, and unlinks back to local.
- Real app: a Linux instance links a Mac mini running `hinacode serve` from this branch, and streams and taps its simulator.
