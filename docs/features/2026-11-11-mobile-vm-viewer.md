# Tiny VM on the phone

Status: Shipped
Date: 2026-11-11

## Problem

An agent that works in a thread's Tiny VM drives a whole desktop, and the desktop app shows it in the side panel. The phone showed nothing. A developer away from the desk could not see what the agent was clicking, or take over when it asked them to sign in, so they had to walk back to the desk.

## User flow

1. Once a thread has a VM, a computer button appears in the thread header: a toolbar item on iOS, a round button next to the actions on Android. It goes away when the VM stops.
2. Tapping it opens the Tiny VM screen. A boat VM's desktop stream fills the screen while the agent keeps working.
3. While the agent has control, a shield covers the stream, so a stray touch cannot type into the agent's screen. Take control lifts it, and the developer drives the desktop with touch. When the agent asks for the VM meanwhile, a notice says it is waiting.
4. Hand back, or leaving the screen, gives control back to the agent, as closing the desktop panel does.
5. Stop VM asks first, then stops the VM. The screen then shows the empty state.

## Design

- **State.** `stores/vms.ts` keeps each thread's `ThreadVm`. It loads with `vm.get` when the thread opens, applies the `vm.updated` push, and reloads after a reconnect, like `stores/subagents.ts`.
- **Screen.** `app/thread/[id]/vm.tsx` loads `vm.desktop.url` and shows it in `react-native-webview` (an iframe on web). Control, stop and retry call the existing `vm.control`, `vm.stop` and `vm.start`.
- **Desktop URL.** In the desktop app, `vm.desktop.url` returned the loopback redirect from `2026-10-30-boat-sandboxes.md` to every caller, so a phone or browser got a `127.0.0.1` link it could not open. The handler now returns the redirect only to its own window (`desktop !== null`), and gives everyone else the boat URL directly, as `hinacode serve` already did. This also removed the serve-only `desktopRedirect` layer flag.

## Out of scope

- The sbx VM screen. It streams VNC over the desktop-only `vm.screen.*` channel, so the phone shows a note to open it on the desktop.
- Landscape. The app is portrait-only, so the 16:9 stream fills the width.
- Starting a VM from the empty state, screenshots, dropping files, and saving the browser profile.

## Verification

Point an isolated desktop at a fake boat API (`BOAT_API_BASE`, `BOAT_API_KEY`), start a VM on a thread, pair the phone, and check:

- the header button appears, and the stream loads from the boat URL, not `127.0.0.1`;
- a tap on the stream does nothing until Take control, and reaches the desktop after it;
- a `vm_click` from the agent while the user has control shows the waiting notice;
- Hand back and leaving the screen both return control to the agent;
- Stop VM confirms, stops, and removes the header button; starting the VM again from the desktop brings it back.
