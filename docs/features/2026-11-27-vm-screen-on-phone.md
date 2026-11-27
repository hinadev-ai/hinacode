# The VM screen on the phone

Status: Shipped
Date: 2026-11-27

## Problem

An agent working in a Tiny VM calls `vm_hand_over` when a step needs a person: signing in, a CAPTCHA, a one-time code, a look at a result. The developer can only answer from the desktop window, because the VM screen streams VNC bytes as push events to the Electron window that opened it. The phone, the web app and the desktop viewing a cloud's thread all get "needs the desktop app". A developer away from the desk learns nothing, and the agent waits until they are back.

## User flow

1. The agent calls `vm_hand_over`. The phone shows a banner, or a system notification in the background: "Waiting for you in the VM: Sign in to GitHub".
2. Above the thread's composer, a card repeats the request with **Open screen**. While the thread has a running VM, the thread's actions menu also offers **VM screen**.
3. The screen opens full height, fitted to the width, with the control state on top: "Agent has control", or "You have control", in amber with the request while the agent waits.
4. **Fit** shows the whole desktop. **Actual size** shows it at one remote pixel per point: one finger pans, a tap clicks, a long press right-clicks and two fingers scroll.
5. **Take control** makes taps and keys reach the VM. A key row offers Esc, Tab, Ctrl, the arrows, Backspace and Enter, and the keyboard button opens a text field. Its text is typed into the VM when the developer presses Send, so an input method, dictation or a pasted password works the same way.
6. **Hand back** returns control and the agent's waiting tool continues. Leaving the screen while holding control hands back after the grace period, as closing the desktop panel does, except during a hand-over, which only Hand back ends.

## Design

### One screen stream for every client

The renderer, the phone and the web app read the screen the same way, through rpc calls that any client may make and that route to the machine owning the thread:

| rpc                                     | Does                                                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `vm.screen.open { threadId, streamId }` | Opens the guest's VNC tunnel for this stream                                                                                            |
| `vm.screen.read { streamId, offset }`   | Answers the bytes after `offset`, waiting up to a second for some. `{ status: "closed" }` once the tunnel ended and every byte was read |
| `vm.screen.send { streamId, data }`     | Writes the viewer's input                                                                                                               |
| `vm.screen.close { streamId }`          | Ends the stream                                                                                                                         |

Bytes are `Uint8ArrayFromBase64`, so they survive the JSON of the remote link and Electron's structured clone alike.

This replaces the `vm.screen.data` and `vm.screen.closed` pushes. A push reached every connected client, so a phone would have received every screen another device was watching. A read answers only its caller. It also bounds the host: a stream keeps at most 2 MB the reader has not taken, then stops reading the tunnel until the reader catches up. The VNC server then sends fewer, newer updates instead of a queue, which is what a slow cellular link needs.

`offset` makes a read safe to repeat. The host drops bytes only when a later read asks past them, so a read whose answer was lost on a reconnect returns the same bytes again.

### Lifetime without a window

A stream used to close when the Electron window that owned it was destroyed. A phone has no such signal, and iOS suspends a backgrounded app's socket. So a stream now closes when nobody has read it for 10 seconds, whoever the reader was. That one rule covers a closed panel, a crashed renderer, a locked phone and a dropped link. The existing hand-back rule then applies unchanged: once the last stream of a thread closes while the developer holds control and no hand-over is pending, control returns to the agent after the grace period.

`src/shared/vmScreenStream.ts` is the client half both apps share: the read loop, a retry while the link reconnects, and sends coalesced while one is in flight, so typing over a 200 ms link sends one call per round trip instead of one per key.

### Phone

- `lib/vm.ts` keeps each thread's `ThreadVm` from `vm.get` and the `vm.updated` push, which already reaches every client.
- A desktop that serves `vm.screen.read` advertises the `vm-screen` remote feature. Without it the card keeps the request but offers no Open screen, and the screen asks the developer to update the desktop.
- The notifier raises a needs-input alert when a thread's VM gains a `request`.
- `app/thread/[id]/vm.tsx` is the screen. It renders noVNC from one page that `scripts/build-vm-screen-html.mts` bundles from `src/vm-screen/`, like the terminal's page. Native loads it in a WebView and talks to it with `injectJavaScript` and `postMessage`. The web build loads it in an iframe sandboxed to scripts only and talks to it with `postMessage`. noVNC 1.7 uses top-level await, so the page is a module script, and Metro never bundles noVNC.
- The page owns noVNC: fit mode, view-only, and typing. React Native owns the stream, and bytes cross between them as base64.
- When the connection reconnects, for example after the app was in the background longer than the 10 second lease, a screen whose stream ended opens a new stream, the same way Reconnect does.
- Text is typed as X keysyms: Latin-1 as itself and anything else as its Unicode keysym, which Xvnc adds to its keymap. That is how the agent's `vm_type` already types CJK.
- The guest's clipboard is not copied to the phone.

## Out of scope

- Resizing the guest's screen to the phone. It would move windows under the agent, and Actual size already gives readable text.
- Landscape. The app is locked to portrait.
- Boat VMs on the phone. Their screen is the vendor's desktop page behind a single-use URL, not a VNC tunnel. The phone says to open it on the desktop.
- Dropping files from the phone into the VM, and guest clipboard text on the phone.

## Verification

- `mcp/server.integration.test.ts` reads the fake VNC server's greeting twice from the same offset, refuses an offset past the stream, sees a stream nobody reads close and hand control back, and sees a hand-over survive its screen closing.
- `ipc.integration.test.ts`: a paired phone opens a VM screen through its encrypted session, reads the greeting as base64, sends its own version and reads the reply, and reads `closed` after closing.
- `shared/vmScreenStream.test.ts`: reads start after the open, ask for each byte once, end on `closed`, and sends made while one is in flight go out together and in order.
- By hand on 2026-11-27, with `verify-hinacode` against a stand-in for sbxd that runs exec on a real TigerVNC display holding a Chromium sign-in page and tunnels port 5900 to it:
  - The desktop panel drew the guest through the new reads, for a thread on this machine and for one on a `hinacode serve` cloud paired with it.
  - The phone's web build at 390x844 paired with the desktop's listener and showed the hand-over card for a `vm_hand_over` call.
  - From the card it opened the screen, tapped the username field, typed with the text field, tapped the password field, typed, and pressed Enter. The guest showed "Signed in as staging-bot".
  - Actual size showed the page at one pixel per point, and a one-finger drag panned it.
  - Hand back ended the agent's `vm_hand_over` call with "The user handed control back".
  - With control taken and no hand-over, closing the phone's browser without closing the stream returned control to the agent about 13 seconds later, the lease plus the grace period. The desktop panel closing its stream returned it in about 2, the grace period alone.
- Not covered: a real iPhone or Android WebView, and the alert on a device. The alert, the actions menu entry and the native WebView bridge typecheck and lint, but ran only in the web build.
