# Device frames

Status: Shipped
Date: 2026-10-27

## Problem

The mobile hub streams an iOS simulator or Android emulator into the side panel. A bare rectangle of pixels does not read as a phone. The developer cannot tell at a glance which platform they are driving, where the notch sits, or which way the device is turned.

## User flow

The hub renders its stream canvas inside `DeviceFrame`. The developer sees an iPhone-like or Pixel-like device around the stream, with a metal frame, side buttons, and the Dynamic Island or the punch-hole camera, in a finish that matches the app theme. When the simulator rotates, the body turns and the stream follows.

## Design

```tsx
<DeviceFrame model="iphone" | "pixel" screen={{ width, height }} orientation="portrait" | "landscape">
  {canvas}
</DeviceFrame>
```

`screen` is the device screen in points, in either orientation. `deviceSpec` (`geometry.ts`) turns the model and screen into one spec: bezel, corner radii, buttons and the camera cutout, all proportional to the screen's short side. A screen shorter than 1.75:1 is drawn as a tablet, with a wider bezel, tighter corners and the camera in the bezel. iPads, foldables and odd emulator skins get a plausible frame with no extra model.

`frameLayout` fits the oriented body into the panel and returns the screen rect in CSS pixels, snapped to device pixels. The child is a normal DOM element at that rect, so the stream stays pixel-exact and pointer mapping stays a flat rect. The Dynamic Island and punch hole are DOM overlays above the child with `pointer-events: none`, because the simulator framebuffer does not contain them.

The body is CSS: a rounded metal gradient with the side buttons, drawn in portrait and centered on the screen. Landscape rotates the body as a whole, with a 500 ms transition that reduced motion turns off, so the buttons stay on the right edges. The stream takes its landscape rect at once. It does not turn with the body.

Themes. The light scheme gets a natural titanium iPhone and a porcelain Pixel. The dark scheme gets darker finishes.

The first version drew a parametric three.js body with lighting, a turn spring and a settle animation on attach. It cost a 148 KB gzipped chunk and a WebGL context per frame, for a frame the developer looks past while they test. It was removed in favor of the CSS body, which already stood in without WebGL.

## Candidates

A downloaded glTF model was compared against the parametric body. The only CC0 smartphone found (poly.pizza, 19 KB) is a flat low-poly toy with chamfered corners, and it has no screen rect to align against. The faithful free models are CC-BY replicas of named iPhones, which brings Apple trade dress into an MIT app. A fixed mesh also has to be stretched to fit each screen, which distorts its corners. The parametric body follows any `screen` and ships no assets. That still holds for the CSS body.

## Out of scope

The back of the device, camera bumps and wallpapers are never visible from the front and are not modelled. Round watch screens, physical button presses and per-model colors are separate work.

## Verification

The dev-only Device frames settings page (`pnpm dev` only, since every `electron-vite build` sets `import.meta.env.DEV` to false) renders both models around a placeholder canvas at phone, tablet, foldable and odd-skin sizes, in both orientations, and in one resizable cell. Its placeholder draws 1px lines at device pixels, so an opening off the pixel grid shows up as blur.

Size. `DeviceFrame` and `geometry.ts` add about 5 KB minified (2 KB gzipped) to the chunk that imports them, and nothing loads later.
