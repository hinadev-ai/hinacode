# Boat sandboxes for Tiny VM and devices

Status: Building (experiment)
Date: 2026-10-30

## Problem

Tiny VM needs the developer's own sbx host on Proxmox. Devices need a local Xcode or Android SDK, and iOS needs a Mac. A developer without that infrastructure gets neither a desktop nor a phone for their agents.

[boat.dev](https://boat.dev/) sells cloud sandboxes. One sandbox is a full Ubuntu VM with SSH, Docker, a public IPv4, a 1920x1080 desktop streamed over WebRTC, and `/dev/kvm`, so the Android emulator runs inside it at full speed. It has a REST API at `https://boat.dev/api/v1` with a `boat_` API key. If boat can sit behind the existing Tiny VM and device seams, one API key replaces the Proxmox host and the local Android SDK.

This is an experiment. It answers one question. Can boat serve as the cloud backend for both surfaces without changing what agents or developers see?

## Trial notes

Tried on 2026-10-30 in a browser and against the live API. The dashboard asks for email, GitHub, Google, or AgentID sign-in. The free trial needs a card. No boat account or API key exists on this machine, so no live sandbox was created. The live API answers `401 sandbox.error unauthorized`, which pins the base URL and the error envelope the client decodes. Everything else below comes from the public docs (`docs.boat.dev/llms.txt`) and is verified against a local fake that speaks the documented shapes. The first run with a real key is the remaining verification step, and the settings page says so.

## User flow

1. Open Settings > Experimental. Turn on Tiny VM and pick the Boat provider, or turn on Devices. Either one shows the Boat API key field.
2. Paste a `boat_` key. The status line reports the account state from `GET /limits`: connected with the sandbox counts, or the exact refusal (no key, key rejected, billing required).
3. In a thread, Start VM creates a boat sandbox for the thread, or resumes the one it stopped earlier. The view shows the boat desktop stream. Agent `vm_*` tools act on the same machine. Take control and hand back work as they do on sbx.
4. Stop VM snapshots the sandbox and stops billing. The disk survives. The next start on that thread resumes it, logins included. Quitting HinaCode stops every boat VM the same way.
5. The device list gains one Android device, "Boat Android (cloud)", while a key is stored. Attach it like a local emulator. First boot creates its sandbox, installs the Android SDK once, and boots the emulator. The agent's `device_*` tools drive it unchanged.
6. Deleting the cloud device deletes its sandbox. The list entry stays as a shutdown device that a later attach recreates.

## Design

### Data shapes

Settings gain two fields. There is no migration, because the settings store merges over defaults.

| Field | Shape | Default |
|---|---|---|
| `experimental.tinyVmProvider` | `"sbx" \| "boat"` | `"sbx"` |
| `experimental.tinyVmBoatSize` | `"small" \| "default" \| "large" \| "xlarge"` | `"default"` |

The API key is a secret named `boat.apiKey` in `Secrets`, never a setting. The `BOAT_API_KEY` environment variable wins over the stored secret, mirroring `SBX_URL`/`SBX_TOKEN`. `BOAT_API_BASE` overrides the API base URL for tests and local fakes.

`ThreadVm.running` gains `provider: "sbx" | "boat"`. That one field drives the renderer (noVNC canvas versus desktop stream) and makes a mixed state, a boat screen on an sbx VM, unrepresentable. For boat, `template` carries the machine size and `profile` is always `"off"`, because the boat snapshot already persists the disk.

The thread to sandbox mapping for resume lives in `<userData>/tiny-vm/boat-sandboxes.json`, `{ [threadId]: sandboxId }`. It is a cache, not a record. Losing it costs one fresh sandbox.

The boat Android device reuses `platform: "android"` with the stable logical id `android:boat.cloud`, which fits the existing `DeviceId` pattern. No device schema or migration changes. The backing sandbox can be deleted and recreated under the same device id, so `thread_device` rows survive.

### One Boat service

`src/main/services/boat/Boat.ts` is an Effect service next to `Linear`. It reads the key from `Secrets`, decodes every response with a schema, and exposes a client with the same structural shape as `SbxClient` (`create`, `get`, `remove`, `exec`, `putFiles`, `getFiles`, `status`, `templates`) plus boat-only calls (`stop`, `resume`, `desktopUrl`, `hostPort`, `limits`, `list`, `readFileBytes`). HinaCode uses `fetch` plus Effect Schema instead of `@boatdev/sdk`, to keep one decoding rule for every network boundary.

Both consumers take the service optionally. `TinyVm` and `Devices` read it with `Effect.serviceOption`, so tests and headless runs without the layer keep working, and `app.ts` provides it in the real graph.

The sbx-shaped methods map onto boat like this.

| Client call | Boat mapping |
|---|---|
| `create(template, env)` | `POST /sandboxes` with `type` from the size setting, `ttlSeconds` 7200, `env`, labels `hinacode=1`, an `Idempotency-Key` per attempt, then poll `GET /sandboxes/{id}` until `ready`, `idle`, or `running` |
| `exec` | `POST /sandboxes/{id}/commands`. The script runs wrapped so stdout and stderr land in guest files, which the client downloads as bytes. Boat exec stdout is JSON text, so this is what lets a screenshot PNG survive the trip |
| `putFiles` | Upload the tar through `POST /sandboxes/{id}/files/upload-url`, then extract it in the guest with `tar` |
| `getFiles` | Tar the guest path in the guest, then download it through `POST /sandboxes/{id}/files/download-url`, refusing over the byte cap from the guest `stat` first |
| `status` | `GET /limits` for the at-once cap plus `GET /sandboxes` for the running count |
| `templates` | The four sizes with their vCPU and memory, so the existing template select lists them |
| `remove` | `DELETE /sandboxes/{id}`. Tiny VM stop does not call it. See below |

Errors keep the existing tags where the meaning matches. A 404 or a `cancelled` sandbox becomes `SandboxGoneError`, so Tiny VM forgets the VM and the next tool call starts fresh. A missing key becomes `BoatNotConfiguredError`. A 401 names the fix (replace the key), a 402 names billing, and a 409 `machine_not_running` after an auto-stop becomes `SandboxGoneError`, so the resume path converges instead of erroring forever. A 409 `snapshot_data_expired` (stopped disks expire after 14 days) becomes `BoatSnapshotExpiredError`, and both start paths discard the mapping and create a fresh sandbox. No upstream error text is ever interpolated into a `BoatError`. Messages are chosen from an allowlist by status and code, and a request id is included only when it matches the documented `req_` shape, so a server message that echoes a key or a signed URL cannot reach the renderer or the logs.

### Tiny VM on boat

`TinyVm` selects its client by provider at client-build time, from the settings it already subscribes to. Switching provider stops every running VM, the same as turning the feature off.

Start converges. If the mapping file names a sandbox for the thread, `GET` it. Archived means resume. Running means adopt. Gone means create and rewrite the mapping. The setup script and env settings apply on create only, as on sbx. Before the setup script, start runs one internal prepare exec that installs `xdotool` and `imagemagick` when missing, because agent input and screenshots need them and the stock image may not ship them.

Stop means boat stop, not delete. It snapshots and ends billing, and the mapping stays. This is the one behavior that differs from sbx, where stop destroys. The view copy for boat says the disk is kept. Deleting a thread's sandbox for good is future work (see Out of scope).

The screen cannot be the sbx RFB tunnel. Boat has no raw TCP tunnel. A new rpc `vm.desktop.url` asks main for a desktop link. The boat desktop URL carries a token in its fragment, so it never reaches the renderer. In the desktop app, `TinyVm` runs a loopback-only redirect server (started lazily, closed with the service) and returns `http://127.0.0.1:<port>/desktop/<nonce>` instead. The nonce is single-use and expires in 60 seconds. On the GET, main fetches a fresh desktop URL (`POST /sandboxes/{id}/desktop`, `overlay=0` added) and answers 302 to it, so the token exists only in main and in the guest web contents. In `hinacode serve`, whose loopback is not the renderer's machine, the rpc returns the boat URL directly. The renderer shows the link in an Electron `<webview>`, the `BrowserView` precedent, because the CSP only allows `hinacode-file:` frames. While the agent has control the webview sits under a `pointer-events: none` shield, so the developer watches without typing into the agent's screen. Take control lifts the shield. Closing the view hands control back through the existing `vm.control` rpc.

Agent input (`act`) translates each `VmAction` to an `xdotool` command on `DISPLAY=:0` in one exec. The guest desktop is 1920x1080, so `vm_screenshot` returns that geometry and clicks use it. The screenshot itself is the existing exec path (`import -window root png:-`), which works because boat exec returns real bytes through the file wrap above.

What boat refuses, by construction. `openScreen` and `openTunnel` fail with a message naming the boat provider. That turns off passkey relay and CDP browser access into the guest while boat is selected. The settings page hides the passkey and profile toggles for boat, and the agent instructions drop the sbx-only helper names.

### Android device on boat

`src/main/services/devices/boatAndroid.ts` implements `DevicePlatformDriver` over one injected runner that comes from the `Boat` service, so tests fake adb by faking the runner.

- `support` is `ready` when a key resolves. With no key the driver is absent from the composite, so nothing renders.
- `list` returns the one logical device. Its state is `booted` when its sandbox runs and the emulator answers `getprop sys.boot_completed`, else `shutdown`. It returns the device while stopped too, which `Devices.restore` requires.
- `boot` finds the device sandbox by the `hinacode-device` label, creates it (`large`, because the emulator needs about 3 GB) or resumes it, runs the documented Android install once behind a guest marker file, starts the emulator detached, and polls boot completion through in-guest `adb`.
- `connect` polls frames. Each tick writes `adb exec-out screencap` to a guest file, downscales it in the guest to a 540-wide PNG, downloads the bytes, and skips the frame when the bytes match the last one. That keeps ADR 0024's newest-frame model. The rate is whatever one round trip costs. There is no queue to fall behind.
- `send` maps commands to in-guest `adb shell input`: touch phases to `input motionevent`, scroll to `input swipe`, keys and buttons to `input keyevent`, text to `input text`, appearance to `cmd uimode night`, open URL to `am start`. Posture refuses, as local Android does. Rotate toggles `user_rotation`.
- `describe` is `uiautomator dump` plus the existing `parseUiHierarchy`. `launch` mirrors the local driver's resolve-activity flow. `create` refuses, as local Android does. `remove` deletes the sandbox.
- `models` is empty and `screenshot` takes one screencap, satisfying the driver type.

One composite driver in `app.ts` merges local Android and boat Android into the single `android` slot. `list` concatenates. `support` is ready when either side is. Per-device calls dispatch on the `android:boat.` id prefix. `Devices.ts`, the contract, the renderer device UI, and the MCP `device_*` tools do not change.

### Security

The key stays in main as a `Secrets` value and is sent only to `boat.dev` (or `BOAT_API_BASE`). Desktop and download URLs carry tokens. Download URLs are fetched only by main. The desktop URL is reached through the single-use loopback redirect above, so the token never enters renderer state or the DOM. Nothing token-bearing is logged, and error messages are allowlisted so upstream text cannot smuggle one in. The webview inherits the existing `lockDownWebview` rules. A boat guest is as untrusted as an sbx guest. Pulled files keep the existing `writeTree` treatment.

### Cost guardrails

Sandboxes bill per second while running. Creates and resumes send `ttlSeconds` 7200, so a forgotten VM archives itself within two hours and inside the free-trial auto-stop cap. Stop and quit both archive, and a boat stop that fails keeps the VM in the running state so the next stop retries it instead of reporting success. The device sandbox uses the same TTL, and its frame loop only runs while a viewer lease is alive. Closing the device viewer does not stop its sandbox, matching a local emulator that keeps booting in the background. The two-hour TTL is the bound. Deleting the device deletes the sandbox at once.

## Out of scope

- A live run against a paid boat account. It needs the developer's signup and card. The design is verified against a local fake and the live 401 path instead.
- Deleting a thread's boat VM sandbox from the UI, and forking sandboxes.
- `boat prompt` (agents inside the sandbox), hosted port URLs in the ports panel, and boat environments.
- Passkey relay, Chromium profile tars, and CDP into the guest on boat.
- More than one cloud Android device, and iOS in the cloud (boat guests are Linux).
- Touch fidelity beyond `input motionevent`, and any frame-rate promise.
- The Mod+Escape hand-back chord while the boat desktop webview has focus. The stream is a separate web contents, so the chord goes to the guest. The Hand back button is the path.
- File drops onto the boat screen while the developer has control, for the same web-contents reason. Drops land while the agent has control and the shield is up.

## Verification

Checkpoints, each ending in a runnable check.

1. Boat client against a fake boat HTTP server in tests. Envelope and error decoding, idempotent create, wait-ready, exec byte fidelity, file round trip, desktop URL, gone mapping.
2. Tiny VM integration against the fake. Start, resume after stop, exec, screenshot bytes, one click becoming one xdotool exec, provider switch stopping VMs, tools hidden while off.
3. Boat Android driver unit tests with a scripted runner. List states, boot script order, frame change suppression, command mapping, describe parsing.
4. `pnpm typecheck`, `pnpm lint`, `pnpm test`, including the messages catalog test.
5. Real app through `verify-hinacode` with `BOAT_API_BASE` pointed at a local fake boat server that also serves a stand-in desktop page. Screenshot settings with the boat status, the VM view on the fake desktop, and the device list with the cloud device. Then screenshot the real `boat.dev` answer with a bad key, proving the refusal copy.

## Principles that changed a decision

- Model the domain. One `provider` field on a running VM, and one logical cloud device id, instead of parallel boat state beside sbx and local Android state.
- Make operations idempotent. Start converges from any prior state (none, running, archived, expired) to one running sandbox per thread, and create sends an idempotency key.
- Boundary discipline. Every boat response is schema-decoded in the client. Nothing downstream sees raw JSON.
- Laziness protocol. No new platform literal, no device contract change, no SDK dependency, no second screen transport. The composite driver and the sbx-shaped client are the whole trick.
