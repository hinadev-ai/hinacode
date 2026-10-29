# 0024. Device screens as newest-frame snapshots

Status: Accepted
Date: 2026-10-27

## Context

The mobile hub streams iOS simulators and Android emulators into the side panel, on this machine or on a paired daemon. Neither platform has a public live-screen API that also takes touch input. `xcrun simctl` has screenshots but no touch, AXe takes a screenshot per frame (15 to 20 fps) and starts a process per tap (1.2 to 1.8 s), and the emulator ships a gRPC controller. The measurements are in [the feature design](../features/2026-10-27-mobile-hub.md).

The remote browser (ADR 0023) already moves a screen over the authenticated rpc connection as the newest JPEG, one request in flight per viewer. A video stream would use less bandwidth, at about 1.6 Mbit/s for H.264 against 3 to 5 MB/s of stills under motion, but it needs keyframes for late viewers, backpressure for slow ones, a WebCodecs decoder and a binary channel. None of those exist yet.

## Decision

Device screens travel as newest-frame snapshots on the existing rpc: JPEG from iOS, PNG from Android, with one long-poll request in flight per viewer. On iOS, a small Swift helper on CoreSimulator and SimulatorKit reads the display's IOSurface on each frame callback and sends input to the guest's HID daemon. It is compiled from source with `xcrun swiftc` on first use. On Android, HinaCode uses the emulator's own gRPC stream and input calls, with token auth.

## Consequences

- Idle devices cost nothing. Both producers emit frames only when the screen changes.
- A slow link lowers the frame rate instead of building a queue. Remote viewing works with no new listener or port.
- The helper depends on private frameworks. An Xcode release can break it, which is how idb and AXe already live. A break shows up as a failed stream with the helper's error, and the listing, boot and agent tools that use `simctl` keep working.
- The npm package ships Swift source, not a binary, so nothing is signed or notarized separately. The first stream on a machine waits about 12 s for the compile.
- Bandwidth under constant motion is higher than video would be. Revisit with an H.264 channel when physical devices or the phone viewer need it, or when a remote link measurably cannot keep up.
