# Showing what the agent does on a device

Status: Shipped
Date: 2026-11-03

## Problem

A developer watches an agent drive a simulator in the Devices view. The stream is fast (about 60 fps while the screen moves), but the agent's input is invisible. The screen jumps to another app, and the only way to learn why is to scroll the transcript for the tool call. When the developer takes control, the agent's next call waits, and the panel says "The agent is waiting for you to hand back" without saying what it is about to do. And when the Devices view is not open, nothing in the side panel shows that the agent is using a device at all.

## User flow

1. The agent calls `device_tap`. A ring appears where it tapped and fades, and a pill at the bottom of the screen says "Tap". A swipe draws a dot that travels along the swipe. Typing, buttons, launches and links show the pill only: "Type 12 characters", "Home", "Launch com.apple.Preferences", "Open myapp://settings".
2. The developer clicks the screen and gets control. The agent calls `device_tap` again. A dashed ring marks the point it wants to tap, the pill says "Next: Tap", and the status line still offers Hand back. A launch or link that waits shows the pill only.
3. Hand back. The marker goes away, and the agent gets the screenshot it gets today.
4. The developer is on the Changes view when the agent first taps. The Devices icon in the activity bar gets a dot, which clears when they open Devices.

## Design

- `AgentAction` in `src/shared/device.ts` is a union of `tap`, `swipe`, `type`, `button`, `launch` and `openUrl`. Points are fractions of the screen, the same space as touch commands, so the renderer places them the way it maps clicks. `type` carries a character count, not the text, because the agent may be typing a password.
- `Devices.act` takes the action and its steps of commands, so one swipe is one action instead of fourteen calls. The service owns the step loop, the gap between steps and the touch-up when a hand back interrupts a swipe. The MCP tools only build the action and take the screenshot.
- Before it sends the first step, `act` publishes `device.agentAction` with the thread, the device and the action, to every thread that has the device. The event is not stored: it is something that happened, and a view that opens later has nothing to replay.
- `ThreadDevice.ready.agentWaiting` changes from a boolean to the `AgentAction` the agent waits to perform, or `null`. When several calls wait, it shows the newest. `launch` waits through the same path.
- The renderer draws the ring, the swipe dot and the pill in an overlay over the canvas that ignores the pointer. Each new action gets a new key, so its animation restarts, and it removes itself when its animation ends. With reduced motion, the ring and dot do not grow or travel; they fade at the spot.
- An `unseen` flag per thread in a small store is set by every `device.agentAction` and cleared while the Devices view is open. The activity bar shows it as the Devices view's dot.

## Out of scope

- A replay of recent actions with a scrubber. The pill shows the latest action only.
- App logs and crash reports for the launched app, for both the developer and a `device_logs` tool.
- Screen recording, for the developer or as a tool.
- Showing typed text.

## Verification

With an isolated instance (the `verify-hinacode` flow on this Mac) and a booted iPhone simulator the test thread created:

- `device_tap`, `device_swipe`, `device_type`, `device_button`, `device_launch` and `device_open_url` through the MCP server each show the matching ring, dot or pill.
- Taking control, then calling `device_tap`, shows the dashed ring at the requested point and "Next: Tap". Hand back clears it and the tool returns the handed-back screenshot.
- With the Changes view open, an agent tap puts a dot on the Devices icon. Opening Devices clears it.
