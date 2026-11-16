# Device hub

Status: Building
Date: 2026-11-13

## Problem

A developer runs agents on a laptop. Every agent that tests a mobile app boots a simulator on that laptop. A stock iOS simulator uses 2.8 GB and a slim one 1.4 GB, so three agents testing at once fill a 16 GB laptop while the developer types. Meanwhile another machine they own sits idle, such as a Mac mini, a Mac Studio, or a Linux box with an Android SDK.

The [mobile hub](2026-10-27-mobile-hub.md) already streams devices from another machine, but only when the thread itself runs there. A thread on the laptop always gets the laptop's devices. A Linux or Windows machine cannot run an iOS simulator at all, so its threads have no iPhone.

The device hub lets one machine run the devices for the others. Threads on any client machine drive the hub's simulators and emulators as if they were local, and hear them.

```
  Android      iPhone
        \      /
   hub machine (any machine that runs HinaCode)
        /      \
 client A      client B
```

A Mac hub serves iOS and Android. A Linux or Windows hub serves Android only. The examples below say "the hub" for whichever machine the developer picks.

## User flow

### Pick a hub

1. Run HinaCode or `hinacode serve` on the hub machine and pair it from the client as usual, by relay sign-in or QR.
2. On the client, Settings > Experimental > Devices gains **Run devices on**, a select with **This machine** and every paired machine. Each option shows what that machine can run today, such as "studio, iOS and Android" or "buildbox, Android only, 2 steps left".
3. Picking a machine opens its **setup checklist** when it is not ready (next section). A ready machine is the whole setup.

### Set up a machine that is not ready yet

4. The checklist reads the hub's own state over the remote connection, so the developer sets up the hub from the client without walking to it. Each row is one requirement with its state and its fix.

| Requirement          | Needed for                      | Fix from the client                                   |
| -------------------- | ------------------------------- | ----------------------------------------------------- |
| Xcode                | iOS                             | Manual. "Install Xcode from the App Store on studio." |
| iOS runtime          | iOS                             | **Install** runs `xcodebuild -downloadPlatform iOS`   |
| simslim              | Recommended, fits 2× simulators | **Install** runs `brew install mobai-app/tap/simslim` |
| AXe                  | `device_describe_ui`, pick      | **Install** runs `brew install cameroncooke/axe/axe`  |
| Android SDK          | Android                         | Manual, or set `ANDROID_HOME`                         |
| Android system image | Android, when the SDK has none  | **Install** runs `sdkmanager` for the newest image    |
| An emulator (AVD)    | Android, when none exists       | **Create** runs `avdmanager create avd` on that image |

5. **Install** shows a pending state in the row and rechecks when it finishes. A row whose fix needs Homebrew and finds none says so and offers the command to copy. A manual row has **Check again**.
6. Required rows gate a platform. Recommended rows never block. The hub serves Android while its iOS rows are still red.
7. The same checklist replaces today's per-platform notes in the Devices panel on every machine, local included. The simslim note in `DeviceList.tsx` becomes one row of it.

### Use it

8. The Devices panel in a client thread lists the hub's devices. The header says **on studio**, so the developer always knows where the phone is. Attach, create, stream, touch, pick element and every toolbar button behave as they do locally.
9. The toolbar gains a headphones button. Sound is off until the developer turns it on for a device, then it plays on the client. Android only for now (see Audio).
10. The agent uses the `device_*` tools (see Agent tools). Their results and the thread instructions say the devices run on the hub, so `localhost` on the device means the hub.
11. The agent builds on the client and calls `device_install` with the `.app` or `.apk` path. HinaCode copies it to the hub and installs it. Locally the same tool installs directly, so the agent learns one tool whichever machine runs the devices.
12. On the hub, its own Devices panel shows which machine and thread holds each device, such as "In use by laptop, Fix login screen".
13. Archiving the client thread deletes the simulators it created on the hub, as it does locally.

### When the hub is gone

14. When the hub is offline, the panel says "studio is offline. Devices come back when it reconnects." and keeps the last list greyed out. The agent's tools fail with the same sentence. HinaCode never falls back to the client's own simulators, because a surprise 2.8 GB boot on the laptop is what the developer set up a hub to avoid.
15. Choosing **This machine** again returns to local devices. Devices the client held on the hub are released at the next claim.

## Design

### Data

Client setting, in `ExperimentalSettings`.

```ts
devicesOn: Schema.NullOr(Schema.String) // environment id of the hub, null for this machine
```

Hub rows. Migration `00NN_thread_device_client`.

```sql
ALTER TABLE thread_device ADD COLUMN client_id TEXT;     -- null: a thread on this machine
ALTER TABLE thread_device ADD COLUMN client_name TEXT;   -- "In use by <name>"
ALTER TABLE thread_device ADD COLUMN claimed_at INTEGER; -- last claim from that client
ALTER TABLE thread_device ADD COLUMN thread_title TEXT;  -- "In use by <name>, <thread title>"
```

Thread ids are UUIDs, so `(thread_id, device_id)` stays the primary key across machines (ADR 0017). A forwarded call carries `client: { id, name }`, the client's `RemoteAccess.identity` and hostname. A local call has none.

Readiness replaces the `simslim` boolean in `DeviceHost`. `PlatformSupport` stays as the driver's gate for listing a platform at all.

```ts
Requirement = "xcode" | "iosRuntime" | "simslim" | "axe" | "androidSdk" | "androidImage" | "avd" | "audioCapture"

DeviceCheck = {
  requirement: Requirement
  state: "ready" | "missing" | "unsupported" // unsupported: iOS rows on a machine that is not a Mac
  needed: "ios" | "android" | "recommended"
  fix: "install" | "manual"                 // install: a fixed command HinaCode runs on the hub
}

DeviceHost = { ios, android, checks: DeviceCheck[], devices: Device[], models: SimulatorModel[] }
Device.holders = { client, clientId, threadId, threadTitle, seenAt }[] // rows held for another machine
```

`platformReady(checks, platform)` in `src/shared/device.ts` derives readiness. The view renders all copy from `requirement` and `state`, so main sends no prose. A running install is a pending state in the renderer, not a check state.

`devices.setup({ threadId, requirement })` runs the one fixed command for an `install` requirement and answers the new `DeviceHost`. It is a lookup table from requirement to argv in `services/devices/setup.ts`, not a command the client sends, so the hub still exposes no shell. `devices.checks` answers the checks alone with a `named` route, so Settings reads every paired machine's readiness without a thread, even when that machine has devices off.

### Routing

Every `device.*` and `devices.*` method that takes a `threadId` routes as `{ to: "owner", entity: "thread", orElse: "deviceHub" }`. It resolves in order.

1. The thread lives on a cloud. Forward to that cloud, as today.
2. The thread is local and `devicesOn` is set. Forward to the hub, with `client` added.
3. Otherwise, handle locally.

The renderer stays unaware of the hub. `DevicesView` calls `device.attach({ threadId, deviceId })` as it does now. The table keeps forcing a route for every new device method. `services/devices/hub.ts` holds the forwarding, so the window router and the agent tools share it. A call to a hub that `Environments` knows is offline fails at once with the offline sentence, instead of waiting out the one-minute offline limit.

### Hub lifecycle

The hub's 5 s sweep releases devices of archived or unknown threads. A client thread is unknown to the hub, so the sweep would delete it within 5 s. The sweep keeps its rule for rows with no `client_id` and leaves client rows alone.

Client rows are a lease the client renews. Every 5 s, and on reconnect, a client with `devicesOn` set sends

```ts
"devices.claim": { client, threads: { id, title }[] } // the client's threads that are not archived
```

The hub releases every row of that client whose thread is missing from the list, and refreshes `claimed_at`, `client_name` and `thread_title` on the rest. A crash on either side, or an archive while the hub was offline, settles at the next claim, with no queue of pending releases. Switching back to **This machine**, or to another hub, sends the old hub an empty claim, retried every 5 s until it lands. That retry lives in memory, so a client that restarts before it lands leaves the rows for **Release**. `services/devices/hubClaims.ts` runs the loop.

A client that never comes back leaves its rows. The hub's panel shows "In use by laptop, last seen 3 days ago" with **Release**. A timeout would delete a simulator a developer kept for a thread on a laptop that was closed over a weekend, so a person decides.

### Agent tools

The MCP device tools go through one `agentDevices` object in `mcp/tools/devices.ts`, which calls the hub through `callHub` when `devicesOn` is set and the local `Devices` service otherwise. That adds the rpc methods `device.act`, `device.look`, `device.describe`, `device.launch`, `device.logs` and the install methods below.

**One tool or many.** The eight tool definitions cost about 1,800 tokens together (6,190 characters of name, description and JSON schema, measured from `DeviceTools`). One `device_operation(kind, ...)` tool would still carry the union of every parameter and description, so it saves perhaps 600 tokens once per request, and those sit in the cached prefix. Clients that defer tools, as Claude Code does, pay only the names until a tool is loaded. Against that, one tool loses per-tool approval (allow `device_screenshot`, ask before `device_tap`), gives the model one long description to pick a variant from, and turns a schema error into "which variant did you mean". We keep separate tools.

The real cost is what each call returns. Every input tool returns a screenshot, about 1,500 image tokens, so a 20-step test spends about 30,000 tokens on screenshots. These changes spend fewer tokens and fewer round trips.

| Change                                                                        | Why                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Input tools take `show: "screenshot" \| "ui" \| "none"`, default `screenshot` | `ui` returns the flattened element list, a few hundred text tokens  |
| `device_tap` accepts `element`, a label or identifier, instead of `x` and `y` | Removes the describe, then compute coordinates, then tap loop       |
| New `device_install({ device?, path })`                                       | The only way to get a build onto a hub, and one tool locally too    |
| New `device_logs({ device?, app?, sinceSeconds? })`                           | The crash or console line is usually the answer a screenshot is not |

`device_install` installs directly when the devices are local. For a hub it packs an `.app` with `tar`, sends it as `device.install.begin`, `device.install.chunk` (4 MB base64, under the 16 MB remote frame limit) and `device.install.end` with a SHA-256. The hub writes it under `<userData>/devices/uploads/<generated id>`, checks the hash, unpacks with `tar --no-same-owner` into a fresh directory, installs, and deletes it. Uploads are capped at 2 GB and dropped after 60 s without a chunk. The tool answers with the bundle id or package name, ready for `device_launch`.

The instructions in `src/main/agents/instructions.ts` change from "install the build with `xcrun simctl install` or `adb install`" to `device_install`, and name the hub when there is one.

### Audio

Sound is per device, off by default, and travels only while a viewer has it on. It works for any viewer on another machine than the device, which covers today's paired daemon as well as the hub. A local viewer already hears iOS through the host's speakers.

**Producers.**

- **Android.** HinaCode boots emulators with `-audio none` and reads gRPC `streamAudio` at 48 kHz stereo S16. The probe (emulator 37.2, 2026-11-13) found that `-audio none` drops only the host backend: the stream still carries the guest's sound, and the emulator never opens a Core Audio output. With the default backend, a `-no-window` emulator holds the hub's output open even when idle and plays every guest sound on the hub's speakers. `-no-audio` silences the stream too, so an emulator started with it reports that it has no sound until it is booted again from HinaCode. The stream sends packets of about 10 ms only while the guest plays, so silence arrives as gaps.
- **iOS.** A simulated app plays through the host's Core Audio. `simhelper` would create a Core Audio process tap (macOS 14.4 and later) on that simulator's process tree, which isolates one device from another booted beside it. A tap can also mute those processes on the hub's speakers while a viewer listens. The probe confirmed the permission: the first tap raises the "System Audio Recording" prompt (`kTCCServiceAudioCapture`), attributed to the responsible app, HinaCode, not to the helper. Until someone answers it, coreaudiod blocks `AudioDeviceStart` and every later tap call from that app, with no error, so a hub nobody is sitting at hangs instead of failing. `TCCAccessPreflight` reads the state without prompting, for the `audioCapture` row. The aggregate device needs the default output as its clock subdevice, or its IOProc never runs. Isolation from a second simulator and `muteBehavior` are still unverified, so iOS sound is not built yet.

**Transport.** Audio cannot be a newest-frame snapshot, because a dropped chunk is a click. `device.audio({ threadId, deviceId, after })` long-polls like `device.frame` and returns every chunk newer than `after`. The producer keeps a 2 s ring. A viewer that falls further behind skips to the newest chunk and plays a gap instead of building latency. Chunks are 48 kHz stereo 16-bit PCM, about 190 KB/s, which is less than one second of screen frames under motion and needs no encoder in Node. The renderer keeps one request in flight, at most one every 50 ms so a reply carries several chunks, and queues each reply as an `AudioBufferSourceNode` started where the last one ends, about 150 ms ahead. After a gap, or when the queue drifts past 500 ms, it starts again 150 ms ahead. A request is the audio lease, so audio stops ten seconds after the last viewer stops asking.

### Trust

The hub accepts device calls only over the authenticated remote connection, from a client holding its pairing token, the same boundary every forwarded call crosses. `client` is a label for the UI and the sweep, not a credential. Every request is decoded by schema. The hub exposes typed methods only: `devices.setup` runs a fixed argv per requirement, appearance and deep links stay `DeviceCommand` cases, and launch stays an `AgentAction`. No device method runs a command the client wrote. Nothing in an upload runs on the hub itself. The simulator runs it, as it runs any build.

### UI

- Settings: **Run devices on** under the Devices switch, with each machine's readiness summary.
- `DeviceChecklist`, shared by settings and the Devices panel, rendered from `Check[]`.
- `DevicesView` header: the hub's name and the offline state.
- Device toolbar: the speaker toggle.
- Hub device rows: "In use by" with `client_name`, last seen and **Release**.
- New strings in all four catalogs.

## Out of scope

- **Reaching the client's dev server from the hub.** A simulator on the hub resolves `localhost` to the hub, so Metro or Vite on the laptop needs the laptop's LAN or Tailscale address. A reverse tunnel needs a byte-stream channel over the remote connection, which ADR 0024 notes does not exist. It is the most likely follow-up, because React Native and Expo work depends on it.
- **Cloud threads on a hub.** A thread on a paired `hinacode serve` keeps that machine's devices. Clouds do not connect to each other.
- **Installing Xcode or the Android SDK from the client.** Both are large, interactive, and need a person at the hub, so they stay manual rows.
- **Video streaming.** Frames stay newest-frame snapshots (ADR 0024). Slice 7 measures whether the relay keeps up.
- **Microphone input**, from the client to the device.
- **Several hubs, or a pool with scheduling.** One hub per client machine.
- **Physical devices.** Same reasons as the mobile hub.

## Slices and checks

1. **Route kind.** `devices` route, `devicesOn`, `client` on forwarded calls. Check: an isolated desktop paired to an isolated `hinacode serve` lists the serve's simulators in a desktop thread, and switching back lists the desktop's own.
2. **Readiness checklist.** `Check[]` in `DeviceHost`, `devices.setup`, the checklist UI on both surfaces. Check: on an instance with simslim and AXe off its PATH, the checklist shows both red, **Install** turns simslim green and the slim note is gone. A Linux `hinacode serve` in the Tiny VM shows iOS as unsupported and Android rows with their fixes.
3. **Hub rows and claim.** Migration, sweep rule, `devices.claim`. Check: an integration test with two runtimes. A desktop thread creates a simulator on the hub, the hub's sweep leaves it, archiving the thread deletes it within one claim.
4. **Agent tools over rpc.** `device.act`, `device.look`, `device.describe`, `show`, `element`, `device_logs`. Check: `mcp-call.ts` against the desktop taps a Settings row by label on the hub's simulator with `show: "ui"`.
5. **Install.** `device_install` and the chunked upload. Check: build `apps/mobile` on the desktop, install it on the hub's simulator and emulator through the tool, launch it, screenshot.
6. **Audio.** Probe first: a process tap on one booted simulator records a sound while a second simulator plays another, and the emulator's `streamAudio` returns PCM with `-no-audio` dropped. If the iOS probe fails, Android ships alone and this doc records why. Then `device.audio`, the worklet and the toggle. Check: play a sound in an app on the hub, hear it on the client, record the renderer's audio output and its latency.
7. **Dogfood over the relay.** Two client threads drive two hub simulators at once while the client's memory stays flat. Measure fps, tap latency and audio gaps over the relay. If drags fall below about 15 fps, that is the trigger ADR 0024 names for an H.264 channel.

## Verification

Integration tests pair a real desktop runtime with a real cloud runtime in `crossMachine.integration.test.ts`. They cover routing to the hub, the client recorded on the hub's rows, the claim releasing an archived thread's devices and everything when the client switches back, and the error an agent gets when the chosen machine is gone. `Devices.integration.test.ts` covers the sweep leaving client rows alone, release by client, the chunked upload (order, size and hash), and the audio ring.

Verified on 2026-11-13 with an isolated desktop paired to an isolated `hinacode serve` on the same Mac, so every call crossed the remote connection:

- **Run devices on** listed "studio, iOS and Android". After picking it, the thread's Devices panel said "on studio" and listed the hub's devices.
- A new iPhone 18 Pro simulator was created, booted and streamed from the hub. The hub's row carried the desktop's name and the thread title, so the claim arrived.
- Over the desktop's MCP server: `device_describe_ui`, then `device_tap` with `element: "設定"` and `show: "ui"`, opened Settings. `device_install` sent a 99 MB `.app` to the hub in 5.8 s, and the uploads directory was empty afterwards. `device_launch` and `device_logs` worked on it.
- Archiving the thread in the window deleted the hub's simulator about 8 s later.
- With the hub stopped, the panel showed the offline sentence. The agent's tools answered it in 0.1 s.
- The hub's Android emulator booted with `-audio none` and streamed. With sound on, the page scheduled 14 s of audio over 14 s of wall time, 8.0 s of it the 8 s test tone at RMS 0.097.

Not verified yet: iOS sound (see Audio), installing an `.apk` on a real emulator, a hub over the relay instead of loopback, the setup **Install** buttons running for real (everything on the test Mac was already installed), and the hub's own panel showing "In use by", which was rendered from ui-states fixtures.
