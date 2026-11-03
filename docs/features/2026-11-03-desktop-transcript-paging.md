# Desktop transcript paging

Status: Not built, measured gain too small
Date: 2026-11-03

## Problem

The desktop loads a thread's whole transcript when it opens. The phone already asks `threads.transcript` for a 64 KB page and loads older pages as it scrolls up. The question was whether the desktop should page the same way, and whether main should page in SQL, since it reads and decodes every message row of the thread before it cuts out a page.

## Measured

On a copy of a real profile with 169 threads: median 252 KB of message rows, p90 1.4 MB, 13 threads over 2 MB, 5 over 4 MB. A message is a whole turn, so large threads have few messages, up to 1,054 parts and 5.5 MB in one row.

`scripts/perf/measure.ts switch` opens each thread from the sidebar, then switches back to it three times. The first open loads the transcript; switching back reuses the cached history. The gap between them is the most that paging could save. Medians of 5 launches, unthrottled:

| Thread         |   Reply | First open | Switch back |   Gap |
| -------------- | ------: | ---------: | ----------: | ----: |
| Largest        |  4.9 MB |     203 ms |      108 ms | 95 ms |
| 2nd largest    |  4.3 MB |     160 ms |      109 ms | 51 ms |
| 3rd largest    |  3.2 MB |     127 ms |       93 ms | 34 ms |
| p90 by size    |  0.8 MB |     145 ms |      108 ms | 37 ms |
| Median by size | 0.18 MB |     108 ms |       93 ms | 15 ms |

- The first page would carry 8 to 235 KB instead of 0.2 to 4.9 MB.
- Switching back costs 93 to 109 ms, and 360 to 520 ms at `CPU_THROTTLE=4`. Paging does not change it: it is rendering the newest turns, and LegendList cannot skip the off-screen parts of one message.
- In main, a page costs the same as the whole thread: 27 to 33 ms for the largest threads, about 1 ms at the median. The phone needs 3 to 6 pages to reach the top of the largest threads, so 75 to 180 ms of main time in total.

## Decision

Don't page on the desktop. It would save at most 95 ms on the single largest thread and about 15 ms on a typical one. To get that, seven features that read older messages would each need a server query or an on-demand load: Find, jumping from a search result, `TodoActivity`, the sub-agent view and its label, `ContextRing`, and the reload after a reconnect. Prepending pages above the reader would also put LegendList's scroll anchoring at risk.

Paging in SQL alone would only help the phone, by the 75 to 180 ms above, so it isn't worth a second read path in `Messages` either.

## Out of scope

- Opening cost from rendering. Profile how one large turn mounts before changing how transcripts load.

## Verification

Copy a profile with `sqlite3 -readonly <db> ".backup <dir>/hinacode.sqlite"`, launch it with `HINACODE_MOCK_AGENTS=stream`, and run `measure.ts <port> <label> switch <threadId...>` once per launch. Give each instance its own X display: when another app's window covers it on a shared Xvfb, Chromium reports the page hidden and `requestAnimationFrame` stops, so the capture hangs.
