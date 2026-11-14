# Paged transcript on the phone

Status: Shipped
Date: 2026-11-02

This draft also proposed paging on the desktop and paging in SQL. Neither was built, because the measured gain was too small. See `2026-11-03-desktop-transcript-paging.md`. What follows is the phone part, which shipped.

## Problem

A long thread's whole transcript is too much to send to a phone and render at once. The phone only needs the newest messages when it opens a thread.

## User flow

1. Opening a thread on the phone shows its newest messages.
2. Scrolling up to the oldest loaded message fetches the page before it, and the page appears above it.

## Design

**Main cuts one page.** The phone calls `threads.transcript` with `compact: true` and `page: {}`, or `page: { before }` with the id of its oldest message. Main reads the whole transcript, with the running turn overlaid, compacts each message and passes the result to `transcriptPage` (`src/shared/compactTranscript.ts`). That keeps the newest messages before `before` whose JSON fits in `TRANSCRIPT_PAGE_BYTES` (64 KiB), and always at least one. `hasEarlier` says whether older messages remain. The desktop omits `page` and gets every message.

**The phone keeps pages.** `apps/mobile/src/stores/messages.ts` stores `hasEarlier` with each thread's history. The chat list calls `loadEarlier` when it reaches its end, and `loadEarlier` prepends the returned page. Pushes that arrive while the page loads are replayed onto it, so a tool result that lands meanwhile is not lost. A reload reads the newest page again and drops the earlier ones.

## Out of scope

- Paging on the desktop and paging in SQL. See `2026-11-03-desktop-transcript-paging.md`.

## Verification

- `src/shared/compactTranscript.test.ts` covers `transcriptPage`: the newest messages that fit, the brackets and commas in the byte count, the `before` cursor and a single message larger than the budget.
- `apps/mobile/src/stores/messages.test.ts` covers `loadEarlier`: the first page, prepending, a server that sends every message, replaying pushes that arrive during a load, a reload, a reset, and a failed load.
