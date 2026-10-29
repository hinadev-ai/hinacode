# Foldable simulators

Status: Building
Date: 2026-10-29

## Problem

The iPhone Duo simulator (iOS 27.1) folds. Folded, it shows a phone-sized cover screen; open, a landscape inner screen. The Devices view streamed only the first screen and had no way to fold the device, so a developer testing a fold-aware layout had to switch to Xcode's DeviceHub.

## User flow

1. Attach an iPhone Duo in the Devices view. The toolbar shows three posture buttons: folded, half open and open, with the current one pressed.
2. Pick one. The device folds or opens, and the view shows whichever screen is lit, in its frame and the right way up.
3. Taps, drags and keys go to the lit screen.

## Design

DeviceHub sets the hinge as an `IndigoVendorDefinedEvent` to the guest's `dtuhidd`, on the `com.apple.coredevice.feature.remote.hid.vendordefined` service: usage page 0xFF61, usage 0x5B, and an `IOCFSerialize`d `{provider: com.apple.Virtualization.VirtualMachines, source: hinge-slider-control, type: range, value: <degrees>}`. CoreMotion reads it as the hinge angle and SpringBoard moves to the screen the angle implies. facebook/idb (MIT) sends the same report in `SimulatorHingeAngle`.

- The helper reads the device type's `capabilities.displays` for every integrated screen's `screenID` and `nativeRotation`, and matches them to the framebuffers by pixel size. A device with one screen behaves as before.
- It registers for frames on every screen and streams the lit one. At start the lit one is the screen that is not black. After a posture command it is the cover screen for folded and the inner screen otherwise. Posture angles are 0°, 90° and 180°, which the guest reports as Closed, PartiallyOpen and OpenFlat.
- The inner screen is drawn rotated by its `nativeRotation`, so frames turn by it on top of the device orientation, and touches map back through both. A touch on a screen other than the first targets that screen's `screenID`, the digitizer `dtuhidd` routes it to.
- Each frame carries the posture, the lit screen's size in points and the inner screen's. The view shows the posture buttons only for a device that reports a posture. `DeviceCommand` gains `posture`.
- The device frame fits the open device in every posture, so folded it is half as wide, as in DeviceHub. Half open, the outline and the screen dip toward the hinge and a crease marks the fold; open, a small notch marks the hinge on the body. Both are `clip-path` polygons with a fixed point count, so a posture change animates.

## Out of scope

- A 3D fold of the screen image for half open. The stream stays flat; only the outline and a crease show the fold.
- Telling half open from open at attach. Both light the inner screen, so an open device reports open until a posture is picked.
- Agent tools for postures, and `device_describe_ui` or `device_screenshot` on the inner screen. AXe and `simctl io` read the first screen.
- Android foldable emulators, which have their own posture API.

## Verification

With `verify-hinacode` and an iPhone Duo: each posture shows the expected screen the right way up, a tap on the inner screen opens the app under it, and an iPhone 17 shows no posture buttons.
