# Shared icons

Status: Shipped
Date: 2026-11-03

## Problem

The desktop draws HinaCode's own icons: stroked, round, on a 24 grid, with one coral sun dot. The mobile app draws Remix glyphs whose `d` strings were copied into `apps/mobile/src/components/icon.tsx`. The two surfaces show the same features with different icons, and a new icon has to be drawn twice or copied from a package that the phone does not use.

## User flow

A developer opens a thread on the phone and sees the same back arrow, branch, shield, folder and spinner glyphs as on the desktop, in the theme's colors, at the phone's sizes.

A maintainer adds an icon once, as one file in `packages/icons/src/`, and exports it from `index.ts`. The desktop imports it from `@hinacode/icons`. The phone adds it to the name table in `apps/mobile/src/components/icon.tsx`.

## Design

`packages/icons` (`@hinacode/icons`, private, no build step) holds one file per icon. Each icon is written against six primitives, `Svg`, `Path`, `Circle`, `Rect`, `G` and `Mask`, imported from `./primitives`, plus the `sun` fill for the accent dot.

- `primitives.tsx` is the DOM version. `Svg` is the old `Icon` base (24 grid, `1em`, `currentColor`, stroke 2.4, round caps and joins) and passes every `SVGProps` through, so `className` and `style` work as before. The shape primitives are the plain element names (`Path = "path"`), so React renders the same DOM as before and `iconDom` can still walk a shape. `sun` is `var(--sun, currentColor)`.
- `primitives.native.tsx` maps the same names to `react-native-svg`. Its `Svg` takes `size`, `color` and `sun` (default `color`) and puts the sun color in a context. `sun` is a marker value that `Path`, `Circle` and `Rect` swap for the context's color, because react-native-svg has no CSS variables. Metro resolves `.native.tsx` on iOS and Android. `primitives.web.tsx` re-exports it for the mobile app's web build. electron-vite never sees either file.

The icons moved with a one-shot codemod, `scripts/move-icons.ts`, deleted once it had run (see the commit that removes it). It rewrote the element names and the base import, moved each static icon file into the package, wrote `index.ts`, and rewrote renderer and site imports to `@hinacode/icons`. Icons that need DOM-only features stay in `src/renderer/components/icons/` on the shared base: `SendGlyph` animates `d` with CSS transitions, `EffortIcon` takes a value, and `LinearIcon` and `OpencodeLogoIcon` are filled brand marks sized only by `className`.

The mobile app keeps its `<Icon name color size>` API. `icon.tsx` becomes a name table that points at `@hinacode/icons` components, named after the component without `Icon` (`ChevronRight`), plus the Remix keys that `src/shared/threadStatus.ts` uses, mapped the way the desktop's `lib/indicators.ts` maps them. The phone picked the desktop's icon for each concept: access modes, guide categories, file kinds and checks match their desktop screens, the connection pill uses `Cloud` and `CloudOff` like the desktop's remote mark, and the back chevron needed a new `ChevronLeftIcon`, the mirror of `ChevronRightIcon`.

Remix paths stay for what we do not draw: brand marks (GitHub, Claude, OpenAI, Meta, opencode), GitHub's pull request states (open, merged, draft, closed), the inbox tray (Remix on the desktop too), the QR scanner, sign out, the system theme's contrast circle, and Linear's in-progress and issue glyphs.

Metro watches `packages/icons` and resolves `react`, `react-native` and `react-native-svg` from the app for files in it, the same way it resolves `effect` for `src/shared`. `tsconfig.json` maps `@hinacode/icons` to the package and sets `moduleSuffixes` so `tsc` checks the native primitives, with `react-native` and `react-native-svg` mapped to the app's type entry points because the package has no `node_modules` of its own.

## Out of scope

- Animating icons on the phone. `SendGlyph` stays desktop only.
- Drawing new icons for every Remix glyph the phone still uses. They move over when someone draws them.
- A build step, a sprite sheet or an icon font.

## Verification

- Desktop: screenshots of the sidebar, a thread, the composer and settings with `verify-hinacode` before and after the move are pixel-identical.
- Mobile: screenshots on the iOS simulator and the Android emulator, light and dark, of Home, a thread with the composer, approvals, settings, the file browser and the overview, side by side with the Remix build.
- `pnpm typecheck && pnpm lint && pnpm test`, and `npx tsc --noEmit` and `npx expo lint` in `apps/mobile`.
