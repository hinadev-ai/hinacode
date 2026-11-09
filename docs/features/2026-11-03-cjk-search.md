# CJK search

Status: Shipped
Date: 2026-11-03

## Problem

Thread search runs on `message_fts`, an FTS5 table with the `trigram` tokenizer. A trigram index can only answer queries of three or more characters. Shorter queries fall back to `LIKE '%q%'`, which reads every stored body. Most Chinese and Japanese words are one or two characters (改, 搜尋, 検索, する), so the most common CJK searches take the slow path.

The same scan also hit any query with `%`, `_` or `\`, because SQLite cannot use the trigram index for a `LIKE` that needs `ESCAPE`.

On a copy of a real database (1,590 messages, 13 MB of indexed text, 18 days of use), a short CJK query scans in 9 to 29 ms. At ten times that data, which is about six months at the same rate, it takes 150 to 660 ms per keystroke.

## Candidates

node:sqlite in Electron 44 bundles SQLite 3.53.4 without ICU, and `@effect/sql-sqlite-node` exposes neither `DatabaseSync.function()` nor anything but `loadExtension`. So the ICU tokenizer is out, and no trigger can call into JavaScript.

| Candidate | Index                                                                           | Short CJK query                                                                       |
| --------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Bigram    | Contentless FTS5 `unicode61` table of CJK unigrams and bigrams, written from JS | `grams MATCH '"搜尋"'`                                                                |
| Segmenter | Same table, filled with `Intl.Segmenter` words                                  | `MATCH` on the segmented query                                                        |
| Vocab     | Trigram only                                                                    | Look up every trigram that contains the query in `fts5vocab`, then `MATCH` their `OR` |

## Measurements

The benchmark scripts compare each candidate's row set with the `LIKE` scan, which serves as ground truth. Latency is the median of 7 runs over the full result set, in milliseconds. "10x" is the same bodies inserted ten times.

| Query  | Matches | Scan | Bigram | Segmenter recall | Vocab | Scan at 10x | Bigram at 10x |
| ------ | ------: | ---: | -----: | ---------------: | ----: | ----------: | ------------: |
| `改`   |      39 | 14.3 |   0.04 |              46% |   281 |         184 |          0.22 |
| `的`   |      87 | 18.8 |   0.03 |              95% |   348 |         228 |          0.40 |
| `嗎`   |       9 | 28.6 |   0.03 |             100% |   334 |         179 |          0.07 |
| `搜尋` |       7 | 16.5 |   0.04 |             100% |   209 |         165 |          0.09 |
| `對話` |      34 |  9.7 |   0.02 |             100% |   173 |         171 |          0.25 |
| `測試` |      21 |  9.2 |   0.02 |             100% |   182 |         338 |          0.43 |
| `分支` |      10 | 10.7 |   0.02 |             100% |   161 |         456 |          0.25 |
| `問題` |      21 | 10.5 |   0.04 |             100% |   158 |         661 |          0.32 |
| `面試` |       3 |  8.8 |   0.01 |             100% |   155 |         190 |          0.09 |
| `検索` |       1 |  8.8 |   0.01 |             100% |   181 |         155 |          0.08 |
| `する` |      16 |  8.9 |   0.02 |              88% |   163 |         149 |          0.30 |
| `確認` |      24 | 10.0 |   0.03 |             100% |   161 |         170 |          0.47 |

Bigram recall was 100% with no extra rows on every query. The segmenter misses a word wherever its dictionary groups the characters differently: 改 inside 修改 is not its own word. Vocab expansion is exact but slower than the scan, because `fts5vocab` walks all 111,641 trigrams.

The other cost columns:

|                       |                                 Bigram | Segmenter | Trigram (today) |
| --------------------- | -------------------------------------: | --------: | --------------: |
| Index size, real data | 4.4 MB with all text, 0.34 MB CJK-only |    4.1 MB |           70 MB |
| Index size, 10x       |                                  40 MB |     39 MB |          419 MB |
| Build, real data      |                                 553 ms |    522 ms |                 |
| Build per row, 10x    |                                 192 µs |    285 µs |                 |

Three-or-more-character queries already used the trigram index. Matching them with an FTS5 phrase (`body MATCH '"search"'`) instead of `LIKE` is still faster, because `LIKE` re-reads every candidate body to confirm the match. On real data, `search` drops from 8.5 to 0.6 ms, `migration` from 6.6 to 1.0 ms, and `snake_case` from 21 to 0.4 ms. The phrase returned the same rows as `LIKE` for every query.

### End to end through `Search`

Old and new `Search` services on the same real-data copy. `threads` uses limit 100 and `perThread` uses limit 50. Both returned identical hits, in identical order, for all 24 queries.

| Query        | `threads` before | `threads` after | `perThread` before | `perThread` after |
| ------------ | ---------------: | --------------: | -----------------: | ----------------: |
| `嗎`         |             31.3 |            12.3 |               33.0 |              14.4 |
| `搜尋`       |             53.4 |            24.5 |               40.2 |              28.0 |
| `分支`       |             15.3 |             3.4 |               15.9 |               4.3 |
| `面試`       |             11.5 |             0.7 |               11.1 |               0.6 |
| `検索`       |             15.1 |             4.8 |               17.8 |               5.9 |
| `snake_case` |             16.4 |             0.8 |               16.4 |               0.8 |
| `的`         |             94.7 |            98.8 |               88.5 |             116.5 |
| `pr`         |              8.8 |             8.7 |               61.1 |              61.6 |

The remaining time goes to reading each hit's full body and building its snippet in JS. CJK hits in this data average 39 KB, and the 41 hits for `改` total 1.6 MB, so the query costs 2 ms, the body reads 11 ms and the snippets 20 ms. That cost grows with the number of hits, not the size of the database. The scan it replaces grows with the size of the database.

Migration 37 took 46 ms on the real copy. The first short CJK search after it indexes every existing message once, which took 240 ms warm. A new message adds one row to `message_cjk_stale` from a trigger. The next CJK search indexed 50 such messages in under 36 ms.

## Design

- `message_cjk` is a contentless FTS5 table (`contentless_delete = 1`, `unicode61 remove_diacritics 0`). It holds only CJK grams: every Han, Hiragana, Katakana, Hangul and `ー` character, plus each adjacent pair within a run. Other text stays out, so the table stays small.
- Triggers on `message` add the row to `message_cjk_stale` on insert and on a completed update, and drop it from both tables on delete. They mirror the `message_fts` triggers. The grams have to be computed in JS, so the triggers only record which rows are stale.
- Before a short CJK query, `Search` re-indexes the stale rows and clears `message_cjk_stale` in one transaction. Searches that never use the table never pay for it.
- `Search` routes each query by its code-point length:
  - Three or more code points use an FTS5 phrase against `message_fts`. This also covers queries with `%`, `_` or `\`.
  - One or two CJK code points use a phrase against `message_cjk`.
  - Anything else short, such as `db` or `改a`, keeps the `LIKE` scan.

A migration that rewrites `message_fts.body` directly, as 0034 did, must also insert the affected rows into `message_cjk_stale`.

## Out of scope

- Short Latin queries (`a`, `pr`, `db`). `threads` stops early because so many rows match. `perThread` still scans, at about 60 ms on real data.
- Snippet cost. Building the snippet in SQL or with FTS5 `snippet()` would remove most of the time left on CJK queries. It belongs with the palette work on `perf/search-palette-keystroke`.
- Ranking. Results stay newest first.

## Verification

- `Search.integration.test.ts` covers one- and two-character Chinese, Japanese and Korean queries, non-adjacent characters that must not match, a mixed short query, a query containing `"`, `perThread`, and re-indexing after an update and a delete.
- The benchmark lives outside the repo. To reproduce it, back up the live DB with `sqlite3 ... ".backup"`, run the bigram, segmenter and vocab candidates over the copy, and compare their row sets with `LIKE`.
