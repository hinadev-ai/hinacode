# Liquid glass

Status: Shipped
Date: 2026-10-27

## Problem

On macOS 26 and later, native apps draw their sidebar and toolbar in glass, so the desktop behind shows through. HinaCode painted every pixel opaque, so it looked out of place next to Finder, Xcode and Safari.

## User flow

Nothing to turn on. On macOS, the title bar, the sidebar and the status bar are glass. The thread view, side panel, dialogs and the compact sidebar overlay stay opaque, because they hold the content. With System Settings > Accessibility > Display > Reduce transparency on, the chrome is opaque again, live. Windows and Linux look as before.

## Design

- `electron-liquid-glass` puts an `NSGlassEffectView` behind the window's web contents. Below macOS 26 it falls back to `NSVisualEffectView`. It is an optional, darwin-only dependency, like `node-mac-permissions`, so `src/main/liquidGlass.ts` loads it with `require` and is undefined elsewhere.
- When it loads, main creates the window `transparent` and adds the glass view. Main also passes `--hinacode-liquid-glass` to the renderer, and the preload exposes it as `window.hinacode.liquidGlass`. The renderer sets `data-glass` on `<html>`.
- The `glass:` Tailwind variant applies under `[data-glass]` and `prefers-reduced-transparency: no-preference`. The body turns transparent, `<main>` keeps `bg-background`, and the three chrome surfaces use `bg-sidebar/80`. The 80% tint keeps the theme's color and keeps muted text near 4.5:1 even over a saturated backdrop.
- The glass follows the native appearance, not the page. `app.setColorScheme` sets `nativeTheme.themeSource` to the theme's scheme (`dark`, `light` or `system`), so a dark theme on a light Mac gets dark glass. Native menus and dialogs now follow the theme too.

## Out of scope

- A setting to turn glass off. Reduce transparency already does that system-wide, and a window cannot become opaque again without being recreated.
- The library's private glass variants (`unstable_setVariant`). Their README says not to ship them.

## Verification

Glass only renders on a Mac, so `verify-hinacode` on Xvfb cannot show it. Launch the build on macOS with `HINACODE_USER_DATA=/tmp/kk-... pnpm exec electron --remote-debugging-port=<port> out/main/index.js`, put a colorful window behind it, and capture the two windows with ScreenCaptureKit. `screencapture -l` captures the window alone, so the glass looks flat. Check light and dark themes, the compact overlay, and `Emulation.setEmulatedMedia` with `prefers-reduced-transparency: reduce`. Check a packaged build too (`electron-builder --mac --dir -c.mac.identity=null`), because the addon must load from `app.asar.unpacked`.
