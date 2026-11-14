# Hina as the default theme

Status: Shipped
Date: 2026-11-03

## Problem

The new mark is a coral sun with ink bars on a paper tile (`scripts/logo.ts`). The Hina Light and Hina Dark themes carry that palette, but nobody sees them unless they open Settings and pick one. A new profile follows the system appearance into the neutral gray themes with a violet accent, and the phone app ships the same zinc and violet. The icon on the Dock and home screen and the app it opens look like two products.

## User flow

1. A new desktop profile, or anyone who never changed the theme, has theme `System`. It now follows the OS between Hina Light and Hina Dark. Switching the OS appearance switches the app live, as before.
2. Settings > Appearance still lists the old gray themes, renamed `Neutral Light` and `Neutral Dark`, so nobody who preferred them loses them. Picking Hina Light or Hina Dark pins one scheme, as before.
3. The phone app has no theme list. Its System, Light and Dark settings now use the Hina palettes.

## Design

### Desktop

`src/renderer/lib/appearance.ts` resolves a theme id to the theme that actually paints: `system` becomes `hina-dark` or `hina-light` from `prefers-color-scheme`, every other id is itself. `useTheme` returns the resolved theme's scheme and code theme (Vitesse), and `applyAppearance` writes the resolved id to `data-theme`. One token changes: focus draws `--ring` at 50%, and Hina's teal ring read 2.05:1 on paper and 2.32:1 on ink. Now that Hina is the default it has to clear the 3:1 the neutral themes do, so the light ring moves to an ink teal (`oklch(0.24 0.04 194)`, 3.03:1 or more on every surface) and the dark ring to a pale teal (`oklch(0.91 0.07 194)`, 3.1:1 or more). `--success` keeps the brand teal. The Hina selectors already override the default tokens, and everything that reads tokens follows: the send halo (derived from `--primary` for every `data-theme` except `light`), the theme preview in Settings, and artifacts, which read computed tokens off `<html>`.

The window still asks the OS for scheme `system` (`app.setColorScheme`), because `themes.system.scheme` stays `system`.

### Mobile

`apps/mobile/src/constants/theme.ts` takes every key from the Hina tokens, converted from OKLCH to sRGB hex. Keys Hina does not define are picked in the same family and checked for WCAG contrast: text 4.5:1 on its background, controls 3:1.

On the phone a card is lighter than the page in dark mode, but Hina Dark's `--surface` (sidebar) is darker than its `--background`. So dark mode shifts one step down: the page is Hina's surface, cards are the ink, and pressed or raised fills are `--muted`. The ink at `#233737` is still the color of every card, composer and sheet.

| Key                                             | Light                 | Dark                  | Source                                                                                  |
| ----------------------------------------------- | --------------------- | --------------------- | --------------------------------------------------------------------------------------- |
| text                                            | `#233737`             | `#f7f7f2`             | `--palette-foreground`                                                                  |
| textResting                                     | `#3e5151`             | `#d8d8d1`             | new, between text and muted                                                             |
| textMuted                                       | `#556767`             | `#b8b8ae`             | `--palette-muted-foreground`                                                            |
| background                                      | `#f7f7f2`             | `#1c2e2e`             | `--background` / dark `--surface`                                                       |
| surface, sheetRaised (light), neutralBg (light) | `#e8e8e0`             | `#233737`             | `--muted` / dark `--background`                                                         |
| surfaceStrong                                   | `#d0d0c6`             | `#324949`             | `--input` / dark `--muted`                                                              |
| sheet                                           | `#f7f7f2`             | `#233737`             | `--background` / dark `--background`                                                    |
| sheetRaised (dark), neutralBg (dark)            |                       | `#324949`             | dark `--muted`                                                                          |
| border                                          | `#e0e0d7`             | `#324949`             | `--border`                                                                              |
| controlOff                                      | `#738484`             | `#758b8b`             | new, ink at 3:1                                                                         |
| primary                                         | `#c0482c`             | `#e56b4f`             | `--primary` (coral)                                                                     |
| onPrimary                                       | `#f7f7f2`             | `#0e1e1e`             | `--primary-foreground`                                                                  |
| attention / attentionBg                         | `#8a5600` / `#f8eaca` | `#f1c45e` / `#463518` | new, amber at hue 70 to 85, clear of coral's 34                                         |
| running / runningBg                             | `#027271` / `#d6f2ef` | `#50b0ae` / `#0e3e3a` | `--success` (teal); light deepened from `#167a79` to clear 4.5:1 on cards               |
| danger / dangerBg                               | `#bd1f3d` / `#fde2e2` | `#f4839a` / `#4d292f` | `--destructive`, background new                                                         |
| link, token                                     | `#a73920`             | `#f48f70`             | new, coral deepened or lifted to 4.5:1 on cards                                         |
| tokenBg                                         | coral at 12%          | coral at 16%          | `--primary`                                                                             |
| halo A to D, core, ink                          |                       |                       | the desktop's Hina send halo: `--primary`, hue +45, hue -35, ink `--primary-foreground` |
| disabled                                        | `#d0d0c6`             | `#425b5b`             | `--input`                                                                               |
| findMatch                                       | link at 22%           | link at 30%           | `--color-find-match`                                                                    |
| scrim                                           | unchanged             | unchanged             | ink-neutral, works on any palette                                                       |
| prOpen, prMerged                                | unchanged             | unchanged             | GitHub                                                                                  |

The worst ratios among the new keys: `textMuted` on `sheetRaised` 4.81 (dark), `running` on `runningBg` 4.61 (dark), `controlOff` on `surface` 3.18 (light), and the halo ink on its lightest stop 3.18 (light). The GitHub syntax colors keep their roles; two move to clear 4.5:1 on the new code background, the light keyword (`#c11e2b`, 4.89) and the dark comment (`#9ea7b3`, 5.16). The splash screen and the Android adaptive icon background change from near-black to paper.

## Out of scope

- Changing other Hina tokens on the desktop, including `--attention`, which Hina inherits from the neutral themes and which sits close to coral in light mode.
- A theme picker on the phone.
- The window's pre-paint background in `src/main/index.ts`, which was near-black for the light theme before this change too.

## Verification

`e2e/features/appearance.feature` checks that System paints `hina-light` and `hina-dark`, and runs the text and focus contrast checks on Hina Light and Hina Dark next to the neutral themes.

Desktop: launch with `verify-hinacode`, leave the theme on System, and screenshot a thread with Markdown and code with `prefers-color-scheme` emulated light and dark. `<html>` should carry `data-theme="hina-light"` or `hina-dark`. Pick Neutral Light and Neutral Dark in Settings and check they still look like the old defaults.

Mobile: screenshot Home, a thread in the `approvals` mock scenario (cards, composer, send button), Settings, a sheet and the Markdown sample on iOS and Android in light and dark, next to the baseline shots.
