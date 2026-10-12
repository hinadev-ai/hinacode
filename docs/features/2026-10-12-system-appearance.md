# System appearance

Status: Implemented
Date: 2026-10-12

## Problem

Appearance settings offer named themes and fonts, but the neutral light palette cannot be selected. The neutral default remains dark when the operating system changes appearance.

## User flow

Open Settings, then Appearance. Choose System, Light, Dark, or an existing named theme using the radio controls. System follows operating system changes while the app stays open. Other choices persist across restarts. Font controls remain independent of the theme.

## Design

`Appearance.theme` adds `system` and `light`. The existing `default` ID remains the dark palette so saved settings keep their appearance. New profiles default to System. Named themes retain their original color schemes.

One `prefers-color-scheme` media query supplies the resolved scheme to the document, diff viewer, and Mermaid through `useSyncExternalStore`. The document applies the palette and `color-scheme` before React mounts. A layout effect updates it when settings or system appearance change.

The native window starts hidden. After the first React commit, the renderer calls `app.ready`. This Void request and response use the existing schema-decoded RPC channel and top-level sender check. Main shows only the requesting renderer's window. SQLite remains the source of saved appearance; no startup cache or new table is needed.

## Out of scope

Custom palettes and new font controls belong to separate changes.

## Verification

Use an isolated Electron instance through `verify-kkcode`. Change the emulated system scheme while System is selected and while explicit themes are selected. Restart the same profile after choosing Light and Dark. Check menus, dialogs, attachments, diffs, and Mermaid in both neutral palettes. Measure rendered text and focus contrast, including translucent rings.

Appearance BDD scenarios cover live system changes, restart persistence, named themes, and font preservation. Startup scenarios capture the selected scheme, computed background, and rendered view at the native show event and when Chromium reports its first contentful paint. These checks do not measure native compositor pixels. The IPC integration test rejects foreign frames and invalid RPC envelopes before showing the requesting window.

Rendered neutral-palette measurements cover foreground and muted text on background, muted, sidebar, and popover surfaces. The minimum muted-text contrast is 4.623:1 in Light and 5.857:1 in Dark. The minimum 50% focus-ring contrast is 3.125:1 in Light and 3.146:1 in Dark. Named palettes keep their existing colors and are not covered by this contrast certificate.
