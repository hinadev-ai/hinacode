# Marketing site redesign

Status: Building
Date: 2026-11-01

## Problem

The site still looked like the HinaCode before the coral mark and the Hina themes. Its demo showed one approval in a mock that did not resemble the app, and it covered a fraction of what HinaCode does now: pull request watch, the MCP tools, remote machines, the phone app, Muse Code. A visitor could not tell from it what running several agents in HinaCode feels like.

## User flow

1. The visitor lands on `/` (or `/zh-tw/`, `/ja/`) and reads the claim: run many agents, know which one needs you. The download button names their platform and links straight to the installer from the latest release.
2. Below the hero is the real HinaCode app in Hina Light, in the page's language. When it scrolls into view, Codex finishes a CSV export in one thread while Claude Code investigates a flaky login test in another and stops to ask for approval.
3. The visitor clicks Allow in the real approval card, then answers Claude Code's question. The agent pushes the branch and summarizes the fix. Every other thread, the worktree panel, the Changes tab and the Pull requests tab (with real data for HinaCode pull requests) can be opened.
4. The page then walks the agent loop in five groups (start, watch, steer, review, ship), the MCP tools agents get, remote machines and the phone, the agents it runs, and an FAQ. Pricing at `/pricing/` says it is free and what the visitor still pays their agent provider.

## Design

- Astro static pages on Workers Static Assets, unchanged deployment. Six routes: home and pricing in `en`, `zh-tw` and `ja`.
- Copy lives under `site_` keys in `messages/*.json`, so `messages.test.ts` checks the three catalogs stay in step. The demo window takes the page's language, so the app speaks it too, and the feature vignettes reuse the app's own strings such as `approval_*`.
- The demo is the real renderer, built for the browser from `site/app/` into `site/public/app/` and shown in an iframe. A small bridge stands in for Electron's preload: it answers each rpc call from `site/app/recording.json` and pushes the recorded events. The recording comes from a real `hinacode serve` cloud with agents mocked by the `demo` scenario. `scripts/site-demo/README.md` shows how to record it again.
- The replay plays the two prompts when the window scrolls into view, then waits for the visitor's Allow and answer, the only points where the recording needs them. Timestamps move to the present and older history stretches back, so the sidebar reads like a real afternoon. Calls the recording cannot answer return an error that says it is a recording.
- Icons are the app's own set, imported from `src/renderer/components/icons/`, with the sun dot in coral. The feature vignettes render to static HTML with no client JavaScript.
- Colors are the Hina Light tokens from `src/renderer/index.css`. Coral stays off text; buttons use the deepened coral. CJK headings scale to 0.8 and Japanese breaks on phrases (`word-break: auto-phrase`).
- The download button reads the latest release from the GitHub API in the browser and swaps in the `.dmg`, `-setup.exe` or `.AppImage` URL, keeping the releases page as the fallback.
- `public/og.png` is a 1200×630 card rendered from the site's own markup.

## Out of scope

A dark site theme, a docs section, a changelog page, and phone app store links (the phone app is built from source for now).

## Verification

Run `pnpm --dir site dev` and drive the demo at 1440 and 390 px wide in each language: allow the command, answer the question, then open the other threads and the Changes and Pull requests tabs. Run `pnpm --dir site check`, `pnpm lint`, and `src/renderer/messages.test.ts`.
