# Contrast setting

Status: Building
Date: 2026-10-15

## Problem

The palettes fix one text contrast for everyone. Dark `foreground` sits at 15.6:1 to keep glare down, and `muted-foreground` sits just above the 4.5:1 floor so tool calls and metadata recede (see `2026-10-14-contrast-hierarchy.md`). That suits most screens, but not all of them. On a dim external monitor, in a bright room or with tired eyes, the receding tier is too faint. On a bright laptop at night, the reading tier is too sharp. Today the only fix is to switch themes.

## User flow

Open Settings, then Appearance. Under the theme picker, drag the Contrast slider, or focus it and use the arrow keys, Page Up and Page Down, Home and End. The whole app, including the theme previews, follows while the thumb moves. The value saves when the drag ends or the key is released and survives a restart. The middle of the track is Standard, the palette as designed.

## Design

`Appearance.contrast` is an integer from -100 to 100, saved with the rest of `appearance`. Settings rows saved before the key existed lay over the default, so old profiles read as 0 without a migration.

`applyAppearance` writes it to the root as `--contrast`, from -1 to 1. Palettes declare `--palette-foreground` and `--palette-muted-foreground`, and one rule in `index.css` derives the text tokens from them:

- **Higher** mixes `foreground` toward black or white, up to all the way, and `muted-foreground` 60% of the way. Both tiers gain contrast. At the end the step between them narrows to 1.2:1 in light and 1.5:1 in dark, which is the price of muted text at 10:1 or more.
- **Lower** mixes `foreground` up to 75% of the way toward `muted-foreground`. `muted-foreground` does not move. The light palette already puts it at 4.64:1, so there is no room below it. Stopping at 75% keeps body text above 6:1 and a visible step between the tiers.

The mix runs in oklab, so it works the same on the oklch neutral palettes and the hex named themes. Every text token that should follow the setting (`popover-foreground`, `sidebar-foreground` and the rest) now points at `foreground`, instead of repeating its value in each palette. The rule lists `[data-theme]` and `.dark` beside `:root`, so a theme preview recomputes the tokens from its own palette.

The slider keeps a draft while it moves and writes `--contrast` straight to the root, so dragging never waits on the rpc. It saves on commit.

| Pair (worst surface)   | Lowest | Standard | Highest |
| ---------------------- | -----: | -------: | ------: |
| Light `foreground`     |   7.08 |    18.15 |   19.25 |
| Light `muted`          |   4.64 |     4.64 |   16.02 |
| Dark `foreground`      |   6.21 |    11.93 |   15.12 |
| Dark `muted`           |   4.86 |     4.86 |   10.00 |
| Light step, fg / muted |   1.53 |     3.91 |    1.20 |
| Dark step, fg / muted  |   1.28 |     2.46 |    1.51 |

"Worst surface" is the lowest ratio across `background`, `sidebar` or `popover`, and `muted`.

## Out of scope

- Borders and surfaces. The setting is about reading text. macOS Increase Contrast and `prefers-contrast` can drive borders later if someone asks.
- Following `prefers-contrast: more`. It would fight a value the user picked by hand.
- Fixing named themes that already miss 4.5:1. Gruvbox Dark's muted text is 4.17:1 on its `muted` surface at Standard. Raising contrast fixes it, lowering does not make it worse.

## Verification

`e2e/features/appearance.feature` sets the slider to each end in Light and Dark, checks every text tier against 4.5:1 and focus against 3:1, and checks that the value survives a restart. With `verify-kkcode`, drag the slider with the transcript and sidebar open and compare screenshots at both ends in both themes.
