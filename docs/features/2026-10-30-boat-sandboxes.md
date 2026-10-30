# Boat sandboxes for Tiny VM

Status: Building (experiment)
Date: 2026-10-30

## Problem

Tiny VM needs the developer's own sbx host on Proxmox. A developer without that infrastructure gets no desktop for their agents.

[boat.dev](https://boat.dev/) sells cloud sandboxes. One sandbox is a full Ubuntu VM with SSH, Docker, and a 1920x1080 desktop streamed from the guest. It has a REST API at `https://boat.dev/api/v1` with a `boat_` API key. If boat can sit behind the existing Tiny VM seam, one API key replaces the Proxmox host.

This is an experiment. It answers one question. Can boat serve as the cloud backend for Tiny VM without changing what agents or developers see?

## Trial notes

Tried on 2026-10-30 in a browser and against the live API. The dashboard asks for email, GitHub, Google, or AgentID sign-in. The free trial needs a card. At first no boat account or API key existed on this machine, so the build was verified against a local fake that speaks the documented shapes, plus the live API's `401 sandbox.error unauthorized`, which pins the base URL and the error envelope the client decodes. Later the same day a trial key ran the real thing end to end: sandbox create, start convergence, exec, screenshot, and the account limits on a `default` sandbox (Ubuntu 24.04, kernel 6.8, 4 vCPU, 7.8 GiB, Docker, Chrome, Node, and both agent CLIs preinstalled). That run found the guest-served file URL race described under Design, which the fake now reproduces.

## User flow

1. Open Settings > Experimental and turn on Tiny VM with the boat provider. The Boat API key field appears. Boat is the default VM provider on a fresh install. An install that already stored experimental settings before boat existed keeps sbx: the first run stamps `tinyVmProvider: "sbx"` into its `settings.json`, so nobody's working host moves under them. Switching is one select either way.
2. Paste a `boat_` key. The status line reports the account state from `GET /limits`: connected with the sandbox counts, or the exact refusal (no key, key rejected, billing required).
3. In a thread, Start VM creates a boat sandbox for the thread, or resumes the one it stopped earlier. The view shows the boat desktop stream. Agent `vm_*` tools act on the same machine. Take control and hand back work as they do on sbx.
4. Stop VM snapshots the sandbox and stops billing. The disk survives. The next start on that thread resumes it, logins included. Quitting HinaCode stops every boat VM the same way.

## Design

### Data shapes

Settings gain two fields. The settings store merges over defaults, so the size needs no migration. The provider gets one stamp in `services/Settings.ts`: a stored `experimental` object without `tinyVmProvider` predates boat, so the first run writes `"sbx"` into it before the store reads the file. Without the stamp, the merge would hand every existing sbx user the new `"boat"` default. A broken or missing file skips the stamp and falls back to defaults, as the store already does.

| Field                         | Shape                                         | Default     |
| ----------------------------- | --------------------------------------------- | ----------- |
| `experimental.tinyVmProvider` | `"sbx" \| "boat"`                             | `"boat"`    |
| `experimental.tinyVmBoatSize` | `"small" \| "default" \| "large" \| "xlarge"` | `"default"` |

The API key is a secret named `boat.apiKey` in `Secrets`, never a setting. The `BOAT_API_KEY` environment variable wins over the stored secret, mirroring `SBX_URL`/`SBX_TOKEN`. `BOAT_API_BASE` overrides the API base URL for tests and local fakes.

`ThreadVm.running` gains `provider: "sbx" | "boat"`. That one field drives the renderer (noVNC canvas versus desktop stream) and makes a mixed state, a boat screen on an sbx VM, unrepresentable. For boat, `template` carries the machine size and `profile` is always `"off"`, because the boat snapshot already persists the disk.

The thread to sandbox mapping for resume lives in `<userData>/tiny-vm/boat-sandboxes.json`, `{ [threadId]: sandboxId }`. It is a cache, not a record. Losing it costs one fresh sandbox.

### One Boat service

`src/main/services/boat/Boat.ts` is an Effect service next to `Linear`. It reads the key from `Secrets`, decodes every response with a schema, and exposes a client with the same structural shape as `SbxClient` (`create`, `get`, `remove`, `exec`, `putFiles`, `getFiles`, `status`, `templates`) plus boat-only calls (`stop`, `resume`, `desktopUrl`, `hostPort`, `limits`, `list`, `readFileBytes`). HinaCode uses `fetch` plus Effect Schema instead of `@boatdev/sdk`, to keep one decoding rule for every network boundary.

`TinyVm` takes the service optionally with `Effect.serviceOption`, so tests and headless runs without the layer keep working, and `app.ts` provides it in the real graph.

The sbx-shaped methods map onto boat like this.

| Client call             | Boat mapping                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create(template, env)` | `POST /sandboxes` with `type` from the size setting, `ttlSeconds` 7200, `env`, labels `hinacode=1`, an `Idempotency-Key` per attempt, then poll `GET /sandboxes/{id}` until `ready`, `idle`, or `running`                      |
| `exec`                  | `POST /sandboxes/{id}/commands`. The script runs wrapped so stdout and stderr land in guest files, which the client reads back as bytes. Boat exec stdout is JSON text, so this is what lets a screenshot PNG survive the trip |
| `putFiles`              | Write the tar into the guest at a temp path, then extract it in the guest with `tar`                                                                                                                                           |
| `getFiles`              | Tar the guest path in the guest, then read the tar back, refusing over the byte cap from the guest `stat` first                                                                                                                |

File bytes move on two transports, picked by size from a guest `stat`. At 5 MiB or under, the direct API endpoints (`GET`/`PUT /sandboxes/{id}/files`, base64) carry them, because the API serves those itself. Over the limit, the signed upload/download URLs carry them. The sandbox serves those URLs itself, and a guest port can answer a moment after `ready` (boat's readiness doc says to retry a failed first connection), so a signed fetch retries dropped connections with backoff and its error names the connection cause code. The first live run failed Start VM on exactly this: the prepare exec's stdout download fetched a guest-served URL once, the fetch threw, and the message said nothing about why.
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

### Security

The key stays in main as a `Secrets` value and is sent only to `boat.dev` (or `BOAT_API_BASE`). Desktop and download URLs carry tokens. Download URLs are fetched only by main. The desktop URL is reached through the single-use loopback redirect above, so the token never enters renderer state or the DOM. Nothing token-bearing is logged, and error messages are allowlisted so upstream text cannot smuggle one in. The webview inherits the existing `lockDownWebview` rules. A boat guest is as untrusted as an sbx guest. Pulled files keep the existing `writeTree` treatment.

### Cost guardrails

Sandboxes bill per second while running. Creates and resumes send `ttlSeconds` 7200, so a forgotten VM archives itself within two hours and inside the free-trial auto-stop cap. Stop and quit both archive, and a boat stop that fails keeps the VM in the running state so the next stop retries it instead of reporting success.

## Out of scope

- Judging a long interactive desktop session on a paid plan. The trial run covered start, exec, and screenshots, not hours of streaming from an EU guest.
- Deleting a thread's boat VM sandbox from the UI, and forking sandboxes.
- `boat prompt` (agents inside the sandbox), hosted port URLs in the ports panel, and boat environments.
- Passkey relay, Chromium profile tars, and CDP into the guest on boat.
- Cloud devices on boat. A boat Android device was built during this experiment and removed before merge: every frame was an exec round trip, so it felt worse than a local emulator, and its first boot needs the `large` size the trial locks. iOS in the cloud is a separate problem. Boat has no macOS machines. Its docs and homepage (checked 2026-10-30) list one guest kind, an x86_64 Ubuntu VM, in four sizes, and the `machineTypes` in `GET /limits` is a size list, not an OS list. The iOS simulator needs macOS and Xcode, so it cannot run in a boat sandbox. Cloud iOS needs a Mac backend behind the same device seam: the developer's own Mac running HinaCode, or a rented Mac (MacStadium, EC2 Mac, Scaleway) driven over SSH with `simctl`. That backend is a follow-up. Running macOS in QEMU inside a boat Linux sandbox was rejected: it breaks Apple's EULA on non-Apple hardware, and the simulator inside it is too slow and flaky to debug in.
- The Mod+Escape hand-back chord while the boat desktop webview has focus. The stream is a separate web contents, so the chord goes to the guest. The Hand back button is the path.
- File drops onto the boat screen while the developer has control, for the same web-contents reason. Drops land while the agent has control and the shield is up.

## Verification

Checkpoints, each ending in a runnable check.

1. Boat client against a fake boat HTTP server in tests. Envelope and error decoding, idempotent create, wait-ready, exec byte fidelity, file round trip, desktop URL, gone mapping.
2. Tiny VM integration against the fake. Start, resume after stop, exec, screenshot bytes, one click becoming one xdotool exec, provider switch stopping VMs, tools hidden while off.
3. `pnpm typecheck`, `pnpm lint`, `pnpm test`, including the messages catalog test.
4. Real app through `verify-hinacode` with `BOAT_API_BASE` pointed at a local fake boat server that also serves a stand-in desktop page. Screenshot settings with the boat status and the VM view on the fake desktop. Then screenshot the real `boat.dev` answer with a bad key, proving the refusal copy.
5. One live trial run in `pnpm dev`. Create, start, exec, and screenshot against the real API, then stop. This is the run that found the signed-URL race.

## Principles that changed a decision

- Model the domain. One `provider` field on a running VM instead of parallel boat state beside sbx state.
- Make operations idempotent. Start converges from any prior state (none, running, archived, expired) to one running sandbox per thread, and create sends an idempotency key.
- Boundary discipline. Every boat response is schema-decoded in the client. Nothing downstream sees raw JSON.
- Laziness protocol. No SDK dependency and no second screen transport in the renderer. The sbx-shaped client is the whole trick.
