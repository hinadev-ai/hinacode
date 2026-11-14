# Marketing site redesign

Status: Shipped
Date: 2026-11-01

## Problem

The site still looked like the HinaCode before the coral mark and the Hina themes. Its demo showed one approval in a mock that did not resemble the app, and it covered a fraction of what HinaCode does now: pull request watch, the MCP tools, remote machines, the phone app, Muse Code. A visitor could not tell from it what running several agents in HinaCode feels like.

## User flow

1. The visitor lands on `/` (or `/zh-tw/`, `/ja/`) and reads the claim: run many agents, know which one needs you. The download button names their platform and links straight to the installer from the latest release.
2. Below the hero is a screenshot of a thread waiting for approval, in Hina Light.
3. The page then walks the agent loop in five steps (start, watch, steer, review, ship), opens the review step with a screenshot of the Files panel, and shows the MCP tools agents get, led by artifacts and Tiny VM on boat.dev. Then remote control: other machines, the relay, the native phone app and the browser. Then the agents it runs, magpie included, and an FAQ. Pricing at `/pricing/` says it is free and what the visitor still pays their agent provider.

## Design

- Astro static pages on Workers Static Assets, unchanged deployment. Six routes: home and pricing in `en`, `zh-tw` and `ja`.
- Copy lives under `site_` keys in `messages/*.json`, so `messages.test.ts` checks the catalogs stay in step.
- The page was designed in pen.dev first (`Site / Landing (redesign)` in the HinaCode pen file), reusing the real app screens. The screenshots in `site/public/screens/` are exported from those screens. An earlier version embedded the real renderer replaying a recorded session; it needed a committed recording that went stale with every UI change, so it was removed.
- Icons are the app's own set, imported from `@hinacode/icons`, with the sun dot in coral. The page ships no client JavaScript beyond the download button and the language menu.
- Colors are the Hina Light tokens from `src/renderer/index.css`. Coral stays off text; buttons use the deepened coral. CJK headings scale to 0.8 and Japanese breaks on phrases (`word-break: auto-phrase`).
- The download button reads the latest release from the GitHub API in the browser and swaps in the `.dmg`, `-setup.exe` or `.AppImage` URL, keeping the releases page as the fallback.
- `public/og.png` is a 1200×630 card rendered from the site's own markup.

## Out of scope

A dark site theme, a docs section, a changelog page, and phone app store links (the phone app is built from source for now).

## Verification

Run `pnpm --dir site dev` and check the home page at 1440 and 390 px wide in each language. Run `pnpm --dir site check`, `pnpm lint`, and `src/renderer/messages.test.ts`.
