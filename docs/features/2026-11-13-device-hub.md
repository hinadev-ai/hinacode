# Device hub

Status: Building
Date: 2026-11-13

## Problem

A developer on a Linux laptop pairs a Mac mini as an environment. Threads that live on the Mac mini already stream its simulators, but threads that live on the laptop only see the laptop's devices, and a Linux machine cannot run an iOS simulator at all. To test on an iPhone the developer has to move the thread to the Mac or switch to another app, and the agent in a local thread cannot reach a simulator either.

## User flow

1. Settings > Experimental > Devices, with Devices on, shows **Device hub**: This machine, or one of the paired environments. The developer picks the Mac mini.
2. Every thread that lives on this machine now lists, boots, creates, streams and drives the Mac mini's simulators and emulators in its Devices tab. Typing, pasting, the toolbar and Pick element work as they do locally.
3. The agent in such a thread calls `device_screenshot`, `device_tap` and the rest, and they act on the same Mac mini device the tab shows. Control and hand back work across the two machines.
4. Threads that live on another environment keep using that environment's own devices.
5. Archiving or deleting a local thread asks the hub to release its devices, so simulators created for that thread are deleted on the hub.
6. Picking This machine again goes back to local devices. Devices attached on the hub stay attached there until the thread releases them.

## Design

- `experimental.devicesHub: string | null` in Settings, an environment id. Null means this machine.
- The `Devices` service gets a hub wrapper that follows the setting through its change stream, since frame polling calls it many times a second. When the setting names a paired environment and the call's thread is in this machine's `thread` table, the call is forwarded with `Environments.forward` as the matching `device.*` rpc method and its result decoded with that method's response schema. While the hub is offline, calls wait and fail the way any forwarded call does, rather than falling back to this machine, so a network blip cannot make the agent create a local simulator. When the setting is null, or names an environment that is no longer paired, the local implementation runs. Because both the rpc handlers and the MCP device tools go through `Devices`, the tab and the agent follow the hub together. A guest's call that arrives on the hub always runs on the hub, even when the hub's own Device hub is set, so two machines that name each other cannot forward a call back and forth.
- New rpc methods so the agent tools can be forwarded: `device.act`, `device.screenshot`, `device.describe`, `device.launch`, and `device.release` for cleanup. All route by thread like the other `device.*` methods.
- On the hub, a thread id that is not in its own `thread` table is a guest. Migration `thread_device.guest` marks rows written for guests, and the periodic release skips missing threads whose rows are guest rows, so the hub does not delete a laptop thread's devices because it has never heard of the thread. Guest rows are released by `device.release`, which the laptop sends to every connected environment when one of its threads is archived or deleted, so a hub picked earlier also hears it. The hub records the thread in `released_guest`, and the periodic release treats its rows like an archived thread's, so a failed deletion is retried and a simulator created during the release is still removed. A later attach or create for that thread clears the record, so an unarchived thread can use the hub again.
- Events: the hub publishes `device.updated` and `device.agentAction` with the guest thread id, and the laptop's `Environments` already relays every pushed event to its windows. Device events do not teach thread ownership, so routing stays as it is.
- Trust: the hub only answers paired clients over the existing authenticated remote connection, and every forwarded payload is decoded with the method's request schema on arrival, like any other rpc call.

## Out of scope

- Installing a build from the laptop onto a hub device. The agent can open URLs and launch installed apps; copying an `.app` or `.apk` across machines is a separate feature.
- Choosing a hub per project or per thread. One hub per machine covers the case of one Mac for devices.
- Chaining hubs. A guest's calls run on the hub they reach.
- Clients connected to the laptop, such as another desktop that pairs it, do not get the hub's `device.updated` events for the laptop's threads, because the laptop relays pushed events to its own windows only. Their Devices tab updates when it fetches again.
- Releasing guest devices while the hub is offline. A release that cannot reach a hub is dropped, and the simulator stays until it is deleted from the Devices list.

## Verification

- `Devices` hub wrapper and the guest release query are covered by tests against a real SQLite DB.
- In the real app: launch two isolated instances with `verify-hinacode`. Instance B has Devices on and an Android emulator. Instance A pairs B as an environment and sets Device hub to B. In a thread on A, attach the emulator, tap, type, paste, use the toolbar, and run `device_screenshot` and `device_tap` through A's MCP server. Archive the thread on A and check that B released the device.
- On the Mac mini, repeat with an iOS simulator from a Linux client.
