# Marketing site redesign

Status: Building
Date: 2026-11-01

## Problem

The site still looked like the HinaCode before the coral mark and the Hina themes. Its demo showed one approval in a mock that did not resemble the app, and it covered a fraction of what HinaCode does now: pull request watch, the MCP tools, remote machines, the phone app, Muse Code. A visitor could not tell from it what running several agents in HinaCode feels like.

## User flow

1. The visitor lands on `/` (or `/zh-tw/`, `/ja/`) and reads the claim: run many agents, know which one needs you. The download button names their platform and links straight to the installer from the latest release.
2. Below the hero is a working copy of the app in Hina Light. Four threads run on their own timelines when it scrolls into view. Two of them ask for the visitor within seconds: Claude Code wants a command approved, Codex asks a question.
3. The visitor allows or denies the command (Enter in the note field denies with the note), answers the question, types into the composer to queue (Enter) or steer (⌘/Ctrl+Enter or the Steer button), switches threads in the Inbox or Threads view, and merges a pull request once its checks pass. The Vite thread shows pull request watch on its own: its failing check is handed to the agent, which fixes it and pushes.
4. The page then walks the agent loop in five groups (start, watch, steer, review, ship), the MCP tools agents get, remote machines and the phone, the agents it runs, and an FAQ. Pricing at `/pricing/` says it is free and what the visitor still pays their agent provider.

## Design

- Astro static pages on Workers Static Assets, unchanged deployment. Six routes: home and pricing in `en`, `zh-tw` and `ja`.
- Copy lives under `site_` keys in `messages/*.json`, so `messages.test.ts` checks the three catalogs stay in step. The demo also reuses the app's own strings (`approval_*`, `question_*`, `pr_checks_*`, `thread_composer_*`), so it uses the same words as the app in every language.
- The demo is one React island (`site/src/demo/`). `engine.ts` is a reducer over threads, each a list of scripted steps; a thread's status (needs you, running, failing, done) is derived from its items and pull request instead of stored. One `Ticker` per thread schedules its next step with a timer, so threads advance independently and pause on an approval or question. `script.ts` holds the four threads.
- Icons are the app's own set, imported from `src/renderer/components/icons/`, with the sun dot in coral. The feature vignettes reuse the demo's components and render to static HTML with no client JavaScript.
- Colors are the Hina Light tokens from `src/renderer/index.css`. Coral stays off text; buttons use the deepened coral. CJK headings scale to 0.8 and Japanese breaks on phrases (`word-break: auto-phrase`).
- The download button reads the latest release from the GitHub API in the browser and swaps in the `.dmg`, `-setup.exe` or `.AppImage` URL, keeping the releases page as the fallback.
- `public/og.png` is a 1200×630 card rendered from the site's own markup.

## Out of scope

A dark site theme, a docs section, a changelog page, and phone app store links (the phone app is built from source for now).

## Verification

Run `pnpm --dir site dev` and drive the demo at 1440 and 390 px wide in each language: allow, deny with a note, answer, steer, queue, merge, and wait for the Vite thread's pull request watch to finish. Run `pnpm --dir site check`, `pnpm lint`, and `src/renderer/messages.test.ts`.
