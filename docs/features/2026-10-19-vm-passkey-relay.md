# VM passkey relay

Status: Built
Date: 2026-10-19

## Problem

A site in the Tiny VM asks for a passkey. The passkey lives on the developer's Mac, in Chrome, Google Password Manager, or a password manager vault. The VM cannot reach it. VNC carries pixels and keys only. Firecracker has no USB device, so a security key cannot pass through. Phone QR sign-in needs a Bluetooth proximity check with the VM itself, and the VM has no Bluetooth near the phone. First sign-in in the VM is the step that blocks, because the persistent browser profile only helps after one sign-in exists.

## User flow

1. Turn on Settings > Experimental > Passkeys from this Mac. It is off by default and sits under the Tiny VM toggle.
2. In a thread with a running VM, click the fingerprint button in the Tiny VM view. HinaCode copies a small extension into the VM, restarts Chromium with the extension and the DevTools protocol, and arms the relay. The view shows "Passkeys ready".
3. Open a site in the VM and choose passkey sign-in. A Chrome window opens on this Mac, on the same site origin. A banner in that window names the origin and the action, sign in or create.
4. Click **Use passkey** in the banner. Chrome shows its normal passkey sheet. Approve with the passkey you already have on this Mac.
5. The assertion returns to the VM page as its own credential result. The sign-in completes in the VM. With the persistent browser profile on, the session survives later VMs.
6. Click **Cancel** in the banner, in the VM view, or let the request time out. The VM page gets the same `NotAllowedError` a dismissed local prompt gives.

## Design

### Settings

`Settings.experimental.tinyVmPasskeys: boolean`, default `false`. Settings merges stored values over the defaults, so there is no migration. Turning it off disarms every relay session. It does not stop running VMs.

### State

One relay session per thread, in memory, owned by `services/tinyVm/passkey/PasskeyRelay.ts`:

```
off ──prepare──▶ ready ──site asks──▶ pending { kind, origin, rpId } ──approve / cancel / timeout──▶ ready
  ▲                │
  └──── VM stops, CDP drops, toggle off ────┘        prepare error ──▶ failed { message }
```

The renderer reads `vm.passkey.get` and follows `vm.passkey.updated` pushes, the same pattern as `ThreadVm`. Only one ceremony is pending per thread. A second request while one is pending fails in the VM with `NotAllowedError`, like a second overlapping prompt on one machine.

### Guest side

Chromium ships an extension API for this job, `chrome.webAuthenticationProxy`. An attached extension receives every `navigator.credentials.get` and `create` call as JSON, and answers with a `PublicKeyCredential` JSON string. The guest browser builds the real credential object, so page code cannot tell the ceremony ran elsewhere, and HinaCode never fakes credential objects.

The extension is three small files held as strings in `passkey/extension.ts`, next to the guest scripts `TinyVm.ts` already keeps as strings. `prepare` tars them to `~/.hinacode/passkey-extension` through the existing files API, then relaunches Chromium with `--remote-debugging-port=9222 --load-extension=... --password-store=basic`.

The proxy API gives the extension no origin. A page-world script in the extension wraps `navigator.credentials.get` and `create`, records the frame origin and challenge, and calls the original. An isolated content script forwards that record to the service worker. The service worker matches records to proxy requests by challenge. The origin it reports comes from `location.origin` in the requesting frame, which page script cannot spoof.

### Transport

Main reaches the guest Chromium's DevTools port through the existing sbx TCP tunnel. `sbx.tunnel` already takes any guest port. A small TCP forwarder in main listens on `127.0.0.1` and pipes each connection into a tunnel to port 9222, so the CDP HTTP and WebSocket endpoints work unchanged. One CDP client in `passkey/cdp.ts` serves both the guest Chromium and the host Chrome.

Main attaches to the extension service worker target over CDP, installs a `Runtime` binding, and calls the worker's arm function, which calls `webAuthenticationProxy.attach()`. Requests arrive through the binding as JSON and decode with a schema before anything reads them. Main answers by evaluating the worker's complete function. The worker completes the request, or completes it with the error the host ceremony returned.

### Host ceremony

The ceremony runs in real Chrome on this Mac, not in HinaCode's Electron browser. Chrome on macOS can use iCloud Keychain passkeys, passkeys in its own profile, USB keys, and phone QR with this Mac's Bluetooth. Electron can reach none of the user's existing synced passkeys.

HinaCode keeps one dedicated Chrome profile at `<userData>/tiny-vm/passkey-chrome` and launches Chrome with a loopback DevTools port, once, on first prepare. Per request it opens a tab on the exact VM page origin, injects the consent banner, and waits. Before the tab navigates, an injected script parks the site's own conditional passkey calls. Many sites start one on load for autofill, and Chrome runs one WebAuthn request per page, so an autofill request would block the ceremony. The banner calls the unparked originals. The click is the user activation the WebAuthn call needs and the consent record. The script then runs `navigator.credentials.get` with options parsed by `PublicKeyCredential.parseRequestOptionsFromJSON`, or the create pair, and returns `credential.toJSON()`. The tab closes. The Chrome process stays for the next request and dies with the app.

Because the ceremony runs on the real origin, the `clientDataJSON` Chrome builds carries the same type, challenge, and origin the VM page expects. Requests from a cross-origin iframe carry `crossOrigin: true` in the VM. A top-level host ceremony builds `false`. V1 relays only requests the content script saw in a top-level frame, and fails iframe requests with `NotAllowedError`. Chromium's `remoteDesktopClientOverride` extension input would fix the iframe case. It is gated to allowlisted remote desktop origins, so it stays out. The guest proxy includes that input in every request it forwards. The host script deletes it before calling the ceremony, since the real origin needs no override and Chrome rejects the input from origins that are not allowlisted. A verification run against webauthn.io confirmed the rejection without the delete.

### Validation

Main checks every request before opening Chrome. The `rpId` must be the origin host or a parent domain of it. The origin must be `https`, or `http` on localhost. The request must arrive while the session is ready and no ceremony is pending. Anything else completes in the VM with an error and never reaches the user. Logs name the `rpId` and the outcome only. Challenges, assertions, and credential ids never reach a log line.

### Button

The fingerprint button lives in the running VM toolbar and the floating header, next to the camera button.

### Prompt

While the toggle is on, the `<tiny-vm>` agent instructions gain one line. Passkey prompts are approved by the user in a Chrome window on their Mac. The agent clicks the site's passkey button and waits. It never asks the user to type a passkey, a vault password, or a code into the VM. There is no MCP passkey tool. An agent can start a sign-in on screen, and only the user's hand in the Chrome window can finish it.

## Security

A relay breaks the guarantee that a passkey only answers the machine it sits on. The W3C remote desktop explainer says this plainly, and this feature accepts it in exchange for sign-in working at all. The controls are narrow and visible:

- Off by default, behind its own toggle under an experimental feature that is also off.
- Every ceremony needs a physical click in the Chrome window plus the authenticator's own user verification. Nothing auto-approves.
- The banner shows the exact origin and whether the site signs in or creates. Main validates the origin against the `rpId` before the banner opens.
- The relay arms only on the user's button press in the VM view. It disarms when the VM stops, the DevTools connection drops, or the toggle goes off.
- Request and response JSON travel on the existing paths only: the sbx tunnel with its bearer token, and loopback DevTools ports on this Mac. The sbx token never enters the guest.
- `vm.passkey.prepare` is desktop-only over remote access, like `vm.screen.open`. A paired phone cannot arm a relay on a cloud.

## Out of scope

- Existing passkeys inside HinaCode's Electron browser. Electron cannot see iCloud Keychain or Chrome profile passkeys, so an in-app ceremony would lock out the passkeys users already have.
- Passkey prompts from cross-origin iframes, conditional mediation (passkey autofill), and WebAuthn extensions beyond what the JSON round trip preserves.
- Windows and Linux host ceremonies. V1 finds Chrome on macOS and fails with a plain message elsewhere. The runner boundary in `hostChrome.ts` is where other platforms slot in.
- Creating the first account credential of any kind. A site with no sign-in path except an existing passkey still needs that passkey to exist somewhere Chrome on this Mac can reach.

## Verification

Checkpoints, in build order:

1. Data shapes land in `domain.ts` and `contract.ts`. Check: `pnpm typecheck`.
2. Relay core moves requests through its state machine with a fake guest and a fake ceremony. Check: tests cover approve, cancel, a bad `rpId`, a second overlapping request, and the failed states for a disabled toggle and a missing Chrome.
3. Prepare can stage the extension and reach a guest port. Check: the extension archive decodes to one folder with the proxy permission, and the TinyVm integration test uploads an archive and opens a tunnel against the fake sbx host. The Chromium relaunch itself is covered by checkpoint 4, since the fake host has no browser.
4. Host ceremony runs for real. Check: `verify-hinacode` against the real sbx host, register at webauthn.io in the VM, and screenshot the success state. The 2026-10-19 run did this end to end. The approval leg answered with a DevTools virtual authenticator in the host Chrome, since no finger or key tap exists in an agent session. A real Touch ID or synced passkey approval in the dedicated Chrome profile still wants one manual pass from the developer.
5. Repo gates pass. Check: `pnpm typecheck && pnpm lint && pnpm test`.
