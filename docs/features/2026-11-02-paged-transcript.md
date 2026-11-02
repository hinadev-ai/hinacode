# Paged transcript

Status: Draft
Date: 2026-11-02

## Problem

Opening a thread on the desktop reads its whole transcript. `threads.transcript` selects every `message` row, parses each `parts` JSON, previews it, sends all of it over IPC, and the renderer decodes it again, while LegendList shows about a dozen rows. On a 200-turn thread the call takes 35 ms in main, of which 3 ms is SQL, and the cost grows with the thread. Startup pays it too, because the app restores the last thread.

The phone already asks for one page (`page.before`), but `transcriptPage` slices that page only after reading and parsing every row.

## User flow

1. Opening a thread shows its newest messages, as it does now.
2. Scrolling up to the top of what is loaded fetches the previous page. The viewport stays where it is while it arrives.
3. Find in thread (`Ctrl+F`) counts matches across the whole thread. Moving to a match in an unloaded page loads pages back to it, then scrolls there.

## Design

**Main reads one page in SQL.** `Messages.page(threadId, before)` selects the newest rows whose running size stays under `TRANSCRIPT_PAGE_BYTES`, so the cost follows the screen, not the thread:

```sql
SELECT * FROM (
  SELECT *, SUM(length(parts)) OVER (ORDER BY created_at DESC, rowid DESC) AS tail_bytes
  FROM message WHERE thread_id = ?1 AND (?2 IS NULL OR (created_at, rowid) < (?2, ?3))
) WHERE tail_bytes - length(parts) < ?4
ORDER BY created_at, rowid
```

`hasEarlier` comes from one `EXISTS` on the row before the first. `AgentRunner.transcript` appends the live turn's messages to the newest page only. `transcriptPage` goes away, and the phone gets the same SQL page.

**The renderer keeps pages.** `stores/messages.ts` stores `hasEarlier` next to `messages`. `MessageList` asks for the previous page from LegendList's `onStartReached` and prepends it, keeping the visible row in place with `maintainVisibleContentPosition`.

**Consumers that assume the whole thread:**

| Consumer       | Today                              | With pages                                                                                                            |
| -------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `ContextRing`  | Last usage                         | Always on the newest page, no change                                                                                  |
| `TodoActivity` | Scans for the latest todo list     | `threads.transcript` returns the latest todo list, which main finds with one query                                    |
| `SubagentView` | Finds the Task call by `callId`    | Loads pages back to the call, which is what the user scrolled to                                                      |
| `FindBar`      | `findMatches` over loaded messages | `threads.find` runs `findMatches` in main over decoded rows and returns message ids, so only a search reads every row |

`findMatches` moves to `src/shared` so main and renderer match the same text, including skill labels.

## Out of scope

- A full-text index. `threads.find` reads the thread only when the user searches, and the paged open is what needs to be fast.
- Evicting old pages while scrolling. LegendList already virtualizes the DOM, and the store's per-thread limit stays as it is.

## Verification

- `scripts/perf/budget.ts` opens a 40-turn thread and restores a 200-turn one. Add a 2,000-turn thread to `seed.ts`: its open time should match the 40-turn one.
- Unit tests for `Messages.page` against a real SQLite DB: page boundaries, a single row larger than the budget, the `before` cursor with equal `created_at`.
- An e2e scenario: scroll to the top of a long thread and see the first message, and find a word that only the first message contains.
