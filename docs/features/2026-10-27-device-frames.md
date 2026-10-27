# Device frames

Status: Shipped
Date: 2026-10-27

## Problem

The mobile hub streams an iOS simulator or Android emulator into the side panel. A bare rectangle of pixels does not read as a phone. The developer cannot tell at a glance which platform they are driving, where the notch sits, or which way the device is turned.

## User flow

The hub renders its stream canvas inside `DeviceFrame`. The developer sees an iPhone-like or Pixel-like device around the stream, with a metal frame, side buttons, the Dynamic Island or the punch-hole camera, and lighting that matches the app theme. When a device attaches, the frame settles into place. When the simulator rotates, the device turns and the stream turns with it.

## Design

```tsx
<DeviceFrame model="iphone" | "pixel" screen={{ width, height }} orientation="portrait" | "landscape">
  {canvas}
</DeviceFrame>
```

`screen` is the device screen in points, in either orientation. `deviceSpec` (`geometry.ts`) turns the model and screen into one spec: bezel, corner radii, depth, buttons and the camera cutout, all proportional to the screen's short side. A screen shorter than 1.75:1 is drawn as a tablet, with a wider bezel, tighter corners and the camera in the bezel. iPads, foldables and odd emulator skins get a plausible frame with no extra model.

`frameLayout` fits the oriented body into the panel and returns the screen rect in CSS pixels, snapped to device pixels. The child is a normal DOM element at that rect, so the stream stays pixel-exact and pointer mapping stays a flat rect. The Dynamic Island and punch hole are DOM overlays above the child with `pointer-events: none`, because the simulator framebuffer does not contain them.

The 3D body is parametric three.js geometry in `scene.ts`, loaded as its own chunk on first use. The camera is placed so one world unit is one CSS pixel at the glass, which keeps the 3D opening and the DOM rect aligned. Rendering is on demand. A frame is drawn on resize, theme or DPR change, and during an animation. Idle costs no GPU.

Motion. Turning between orientations is a spring on the in-plane angle and the fit scale. The child gets the same rotation as a CSS transform in the same frame, so the stream turns with the glass. Attaching tilts the device up from the panel, and the stream fades in as it lands. Under reduced motion both are instant. Without WebGL, or while the chunk loads, a flat CSS frame with the same silhouette stands in.

Themes. The light scheme gets a natural titanium iPhone and a porcelain Pixel. The dark scheme gets dark finishes and a rim light so the edge separates from the panel.

## Candidates

A downloaded glTF model was compared against the parametric body. The only CC0 smartphone found (poly.pizza, 19 KB) is a flat low-poly toy with chamfered corners, and it has no screen rect to align against. The faithful free models are CC-BY replicas of named iPhones, which brings Apple trade dress into an MIT app. A fixed mesh also has to be stretched to fit each screen, which distorts its corners. The parametric body follows any `screen` and ships no assets.

## Out of scope

The back of the device, camera bumps and wallpapers are never visible from the front and are not modelled. Round watch screens, physical button presses and per-model colors are separate work.

## Verification

The dev-only Device frames settings page (`pnpm dev` only, since every `electron-vite build` sets `import.meta.env.DEV` to false) renders both models around a placeholder canvas at phone, tablet, foldable and odd-skin sizes, in both orientations, and in one resizable cell. Its placeholder draws 1px lines at device pixels, so an opening off the pixel grid shows up as blur.

Measured in the real app on macOS. An idle page issues no WebGL draw calls. A turn draws only while the spring runs, and under reduced motion it lands in the next frame. With WebGL disabled the flat frame renders the same silhouette.

Size. `DeviceFrame` and `geometry.ts` add about 5 KB minified (2 KB gzipped) to the chunk that imports them. The lazy 3D chunk is 581 KB minified (148 KB gzipped), almost all of it three.js. `motion` is already in the app bundle.
