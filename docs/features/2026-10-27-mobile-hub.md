# Mobile hub

Status: Shipped
Date: 2026-10-27

## Problem

An agent building an iOS or Android app can compile and install it, but the developer still has to switch to Simulator.app or Android Studio to see what it did, and the agent cannot see the screen at all. When the thread runs on another machine, such as a Mac mini paired to a laptop, the simulator is on a screen the developer cannot reach.

Running many agents in parallel makes it worse. Every agent that needs a simulator ends up sharing one, or the developer boots one per agent and runs out of memory. A stock iOS 27 simulator uses 2.8 GB on this Mac mini.

## User flow

1. Turn on Settings > Experimental > Devices. A Devices view joins the side panel, and its agent tools join the thread's MCP server.
2. The Devices view lists the thread machine's iOS simulators and Android emulators. They are grouped by platform, with booted devices first. Each row shows the OS version, boot state, slim state and measured memory. A platform the machine cannot run shows why and how to fix it, such as "iOS simulators need a Mac with Xcode. This machine runs Linux." or "Install the Android SDK, or set ANDROID_HOME."
3. **New simulator for this thread** creates `hinacode-<thread>` from the newest iPhone and iOS runtime, slims it with simslim and boots it. The view shows each step. Without simslim it says "Install simslim to fit about twice as many simulators: `brew install mobai-app/tap/simslim`" and boots the device stock.
4. **Attach** on any listed device streams it into the panel instead. Attaching a shut-down device boots it. Detaching stops the stream and leaves the device running. HinaCode never shuts down, slims or deletes a device it did not create.
5. The screen is live. Clicking and dragging becomes touch, the wheel scrolls, typing reaches the focused field, and pasting types the clipboard. The toolbar has Home, Lock, Volume, Rotate, Light/Dark and Open link, plus Back and Recents on Android.
6. **Pick element** turns the cursor into a crosshair. Clicking attaches a crop of the screen and the accessibility element under the pointer (label, identifier, role and frame) to the composer.
7. The agent calls `device_screenshot`, `device_tap` and the rest. The first user input takes control, and the view says "You have control" with Hand back. While the user has control, the agent's input tools wait, and the view turns amber when one is waiting. Handing back returns the current screen to the waiting tool without acting.
8. Archiving the thread deletes the simulator HinaCode created for it.

Everything above works the same when the thread lives on a paired `hinacode serve` daemon. Devices are listed, booted, streamed and driven on that machine.

## Measurements

Measured on the Mac mini M4 (16 GB) with six other simulators booted, against `hinacode-verify-*` devices.

| Producer | fps under motion | Tap to first changed frame | Idle cost | Frame size |
|---|---|---|---|---|
| iOS, AXe `stream-video` (screenshot per frame) | 15 to 20 at 30 requested | 1.2 to 1.8 s per `axe tap` process | Constant capture | 177 KB JPEG, 1206×2622 |
| iOS, SimulatorKit IOSurface + frame callback (our helper) | 39 at full size, 80 to 86 at 600 px wide | 74 to 194 ms | 0 frames | 136 KB JPEG q0.5 full size, about 45 KB at 600 px |
| Android, gRPC `streamScreenshot` PNG 540×1200, host GPU | 33 to 59 | 75 to 194 ms, about 650 ms when the tap opens an activity | 0 frames | 76 to 124 KB PNG |
| Android, gRPC RGB888 full size | 23 | | 0 frames | 7.6 MB raw |
| Android, `adb screenrecord` H.264 540×1200 | 28 | | Continuous stream | 1.6 Mbit/s |
| Android, `adb screencap` polling | 3.7 | | | |

In the real app the renderer drew about 41 fps from the iOS simulator and 36 to 45 fps from the emulator during drags, and about 40 fps from a simulator on a paired daemon over its remote connection. Those runs drove the pointer one CDP call per step, so they are a floor. The latency includes the app's own response, so a tap that opens an activity measures app time, not transport. AXe batches read stdin to EOF and probe accessibility on every step (about 0.5 s), so no AXe mode can carry interactive input. simslim brought the clone from 2.79 GB and 260 processes to 1.43 GB and 116 processes. Its own profile estimate says 2.1 GB, so the UI shows the measured footprint instead of an estimate.

## Design

### Data

`src/shared/device.ts` defines the contract.

- `DeviceId` is `ios:<UDID>` or `android:<AVD name>`. AVD names are stable across boots, and adb serials are not.
- `Device` is a listed device: id, platform, name, OS version, `state` (`shutdown`, `booting` or `booted`), `slim` (disabled and total services, or null), `memoryBytes`, and `ownerThreadId` when HinaCode created it.
- `PlatformSupport` is `ready`, `unsupported` with a reason (`notMac`), or `missing` with the tool (`xcode`, `androidSdk`). The view renders the copy, so main sends no prose.
- `ThreadDevice` is the per-thread state machine, pushed as `device.updated`:

```
none ──attach/create──▶ preparing { step: creating | slimming | booting | connecting }
                             └──▶ ready { device, screen, control: agent | user, agentWaiting }
                             └──▶ failed { message } ──attach/create──▶ preparing
ready ──detach──▶ none           ready ──device crashed or deleted──▶ failed
```

- `DeviceCommand` is a closed union: `touch` (down, move, up), `scroll`, `key` (DOM `code`, down or up), `text`, `button` (home, lock, volumeUp, volumeDown, back, recents), `rotate`, `appearance` (light or dark) and `openUrl` (any URL with a scheme, since deep links are the point). Coordinates are fractions of the screen, from 0 to 1. Input mapping stays a flat rect whatever scale the frame was encoded at.
- `DeviceFrame` is `{ sequence, mime, data, width, height }`. `mime` is `image/jpeg` for iOS and `image/png` for Android, because the emulator already encodes PNG and the daemon has no image encoder.

The `thread_devices` table holds one row per thread: `thread_id` (primary key), `device_id` and `owned`. One device per thread, so "which device do the agent tools drive" has one answer. `owned` decides whether archiving deletes it. The row survives restarts, so a thread archived after a crash still cleans up.

### RPC and routing

`devices.list`, `device.get`, `device.attach`, `device.create`, `device.detach`, `device.frame`, `device.command`, `device.control` and `device.pick` all take a `threadId` and route to the thread's owner (ADR 0017). The list is the thread machine's list, so a laptop paired to a Mac mini lists and drives the Mac mini's simulators. A Linux daemon reports iOS as `unsupported: notMac` and still lists its Android emulators.

`device.frame({ threadId, after, visible })` follows the remote browser. It returns the newest frame newer than `after`, waits up to one second for one, and returns `null` when nothing changed. Each viewer keeps one request in flight, so the frame rate adapts to the link and a slow viewer never queues stale frames. A frame request is the stream's lease. The producer stops ten seconds after the last one, and a hidden view asks with `visible: false`, which renews nothing.

### Producers

`services/devices/` holds one module per platform behind a small `DevicePlatform` interface: list, boot, create, delete, open a stream, send commands, screenshot, describe UI.

- **iOS.** `simhelper`, a Swift program on CoreSimulator. It registers a frame callback on the main display, encodes the IOSurface to JPEG with Core Image when a frame lands (coalescing while an encode runs), and writes length-prefixed frames to stdout. It reads commands on stdin. Touch, keys and buttons go over XPC to the guest's `dtuhidd`, because Xcode 27 drops Indigo key and button messages sent through `SimDeviceLegacyHIDClient`. Rotation is a GSEvent to `PurpleWorkspacePort`. Events are spaced at least 16 ms apart and a touch is held at least 60 ms, because `dtuhidd` stamps events on arrival and a down and up written together register as nothing. It runs once per streamed device. The source ships with the app and is compiled with `xcrun swiftc` on first use into `<userData>/devices/`, keyed by source hash, so the package carries no binary and Xcode is the only requirement. The first compile takes about 10 s. Text is typed as US-layout key presses, because `simctl pbcopy` leaves the simulator's pasteboard empty on iOS 27, so non-ASCII text cannot be typed yet. Lists, boot, create, delete, appearance, open URL, launch and pasteboard use `xcrun simctl`. `axe describe-ui` answers describe UI and pick.
- **Android.** The emulator's gRPC endpoint, found through its discovery file in the emulator's `avd/running` directory. HinaCode boots AVDs with `-grpc-use-token`. Without it, the emulator listens on every interface with no authentication. An emulator the user started without gRPC can be listed and booted but not streamed, and the view says how to restart it. Frames come from `streamScreenshot` PNG at 540 px wide. Touch and rotation use gRPC. Keys, text and buttons use `adb shell input`, because an AVD without a hardware keyboard (`hw.keyboard=no`, the default) ignores gRPC key events. Non-ASCII text goes through the device clipboard. Appearance, deep links and launch use `adb shell`. `uiautomator dump` answers describe UI and pick.
- **simslim.** `simslim on`, `list --json`, `measure --json` and `delete --json`, like `gh` in ADR 0010. Thread simulators are created with `simctl create` from the newest iPhone type and runtime, not cloned. `simslim clone` boots and shuts down its source to read overrides, so cloning one of the user's devices would reboot it, and two threads cloning one base would race. A fresh device takes one 28 s boot and starts clean, and the agent installs the build it just made either way.

### Control

The Tiny VM rule, except that the user's first pointer or key input takes control instead of a button, because a developer who touches a phone screen means to use it. Agent input tools wait while the user has control, and return the current screen without acting on hand back. Closing the view while the user has control hands it back.

### MCP tools

`device_screenshot`, `device_tap`, `device_swipe`, `device_type`, `device_button`, `device_launch`, `device_open_url` and `device_describe_ui`, hidden with `McpSchema.EnabledWhen` while the experiment is off. They act on the thread's device and create a slim one on first use when none is attached. Input tools return a screenshot 500 ms after acting. `device_describe_ui` returns the accessibility tree flattened to one line per element with its frame, which costs the agent far fewer tokens than a screenshot.

### UI

`DevicesView` in the side panel registry. The screen is a canvas inside the `DeviceFrame` from the device-frames branch, laid exactly over its screen rect. Until that lands, `PlainDeviceFrame` takes the same props and draws a rounded rect.

A stalled stream (no frame for 5 s while the device is booted and the screen is changing) shows "Reconnecting" over the last frame and restarts the producer. A crashed device moves to `failed` with Retry.

## Out of scope

- **Physical devices.** iOS devices have no public screen stream, and polling `adb screencap` reaches 3.7 fps. Streaming H.264 from `screenrecord` into WebCodecs reaches 28 fps, but it is a continuous stream with keyframes and backpressure, not a newest-frame snapshot. That is a separate transport, worth building when someone needs a real phone.
- **Per-thread Android emulators.** An AVD costs gigabytes of disk and a minute to create, and simslim is iOS-only. Threads attach existing AVDs.
- **A cloned base device.** See Producers.
- **A "memory saved" figure.** simslim measures the current footprint only, and its profile estimate overstates the saving by half. The view shows measured memory, so a slim device and a stock one can be compared side by side.
- **Non-ASCII text on iOS.** See Producers. Android handles it.
- **The viewer in the phone app.** The rpc contract already works over the relay, so this is UI work for a later slice.
- **Audio, multi-touch gestures, hardware keyboard toggling, location and push simulation.**

## Slices and checks

1. **Contract.** `src/shared/device.ts`, routes and rpc stubs. Check: schema tests reject out-of-range coordinates and unknown commands, and `routes.ts` compiles with every new method routed by thread.
2. **Listing.** iOS and Android lists with support states and slim status. Check: the Devices view in an isolated instance lists the user's booted simulators without touching them, and an instance started with no Android SDK says so.
3. **Stream and input, iOS.** simhelper, frames over rpc, touch, keys, buttons and rotate. Check: in the real app, tap through Settings on `hinacode-verify-ios-*`, record a video, read fps from the frame sequence.
4. **Stream and input, Android.** gRPC producer. Check: the same on `hinacode-verify-android-*`.
5. **Thread devices.** Create, slim, boot with progress, delete on archive. Check: create from the view, archive the thread, and confirm with `simctl list` that the device is gone.
6. **Agent tools and control.** Check: `mcp-call.ts` taps through the app while the view watches, and a tap waits while the user has control.
7. **Pick element.** Check: picking a button attaches a crop and its label to the composer.
8. **Remote.** Check: an isolated desktop paired to an isolated `hinacode serve` lists, streams and drives a simulator that is a child of the daemon's machine.
9. **Dogfood.** Check: `apps/mobile` runs on both devices and the agent drives it.

## Verification

Tests cover the contract decoding, the command mapping to Indigo and gRPC calls, and the `thread_devices` cleanup on archive against a real SQLite database. The streams and HID only run on real devices, so the slices above are checked in the real app with `verify-hinacode`, including the remote path.

Verified with an isolated Electron instance driven over CDP, and with that instance paired to a plain Node `hinacode serve` daemon on the same Mac. Locally, a slim iOS 27 simulator and an Android 16 emulator streamed inside their device frames. Taps, drags, Home, Back, dark appearance and rotation reached them, and a picked Settings row arrived in the composer with its crop. Over MCP, `device_launch`, `device_describe_ui` and `device_tap` drove Settings. A `device_tap` sent while the user had control waited with the amber notice and returned without acting on hand back. Archiving a thread deleted the simulator HinaCode had created for it within one sweep, about 6 s, and left every other device running. Through the daemon, the list was the daemon's, the screen helper ran as the daemon's child, compiled into its own data directory, and the desktop drove the simulator at 25 to 40 fps on loopback. Any panel input takes control, the toolbar buttons included, because the user is acting on the device either way.

Not verified yet: a Linux daemon's `notMac` state, a cold Android boot from HinaCode, and an emulator started without gRPC.

