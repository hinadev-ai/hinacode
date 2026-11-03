# Open message parts

Status: Building
Date: 2026-11-03

## Problem

A running turn is one `message` row, and its `parts` column holds the whole turn as one JSON string. While the turn streams, the runner saves it every 500 ms, and every save rewrites that string. A turn of N bytes therefore writes about N²/2 bytes over its life, all on the main thread through `DatabaseSync`.

On the `hinacode serve` daemon of this VM, the database is 184 MB, 106 MB of which is message JSON, and the largest row is 5.5 MB with 395 parts. In 6.8 hours the daemon wrote 3.17 GB, 17 times the size of the whole database. Six agents streaming long turns spend most of the main thread on these rewrites, and every rpc waits behind them.

PR #553 saves less often as a turn grows. That reduces the bytes but keeps the quadratic shape and widens the window a crash loses.

## User flow

Nothing changes for the user. Transcripts, search, fork, steer, stop and thread deletion behave as before, and a crash loses at most the last 500 ms of a turn, as before.

## Design

A message is open until the runner sets its `completed_at`. Only the last message of a running turn is open, and `closeInterrupted` closes any that a quit or crash leaves behind.

**An open message keeps its parts in `message_part`, one row per part.** A closed message keeps them in `message.parts`, as before.

```sql
CREATE TABLE message_part (
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  part TEXT NOT NULL,
  PRIMARY KEY (message_id, idx)
)
```

`foldEvent` changes a message without touching the parts it leaves alone: a delta replaces the last part, `tool_call_started` appends one, and `tool_call_finished` replaces the one it finishes. Every other part keeps its object identity. So `Messages.update(message, previous)` writes only the parts where `message.parts[i] !== previous.parts[i]`, in one `INSERT OR REPLACE`. A save costs the size of what changed, usually the one text part the deltas are growing.

The runner already tracks which messages changed since the last save. It now remembers the version it last saved for each, and passes that as `previous`. When a save fails, the messages it did not write keep that saved version as `previous`, so the next save rewrites everything that changed since.

Closing a message moves its parts back. In one transaction, `update` writes the whole array to `message.parts` with `completed_at`, then deletes the message's `message_part` rows. That is one write of the turn's size, once per turn. The FTS trigger fires on that `UPDATE OF parts`, as it does today, so search keeps indexing completed messages and needs no change.

**Reads take the part rows when a message has any, and `message.parts` otherwise.** `Messages.list` and `closeInterrupted` select

```sql
coalesce(
  (SELECT '[' || group_concat(part, ',' ORDER BY idx) || ']' FROM message_part WHERE message_id = message.id),
  message.parts
) AS parts
```

so the decode in `MessageRow` stays the same. `toolOutput` looks in `message_part` as well as in `message.parts`.

**Why not move every message into `message_part`.** It would give one representation, but completed messages never change part by part, and their single JSON string is what the FTS triggers, fork's `INSERT … SELECT`, session imports, the data-dir path rewrite, the perf seed scripts and the e2e fixtures all read and write. Moving them all would rewrite 106 MB on upgrade and change each of those, to make writes cheaper for rows nobody writes. Keeping the split at `completed_at` limits the change to `Messages.ts`, the runner's save, and one migration.

**Why not patch the JSON in place.** `json_set` still makes SQLite rewrite the whole record, so the bytes written stay the same.

**Migration `0037_message_part`** creates the table and moves the parts of every open message into it, so a database that crashed mid-turn reads back the same before and after. Closed messages do not move.

With this, a save no longer grows with the turn. The byte budget from #553 still spaces saves by the bytes the last one wrote, which is now the size of the changed parts, so streaming turns keep the 500 ms cadence.

## Out of scope

- Changing the 500 ms save interval. The crash window stays where it is.
- Splitting very long text parts. A single text part that grows to megabytes without a tool call in between still rewrites itself on each save. Real turns interleave tool calls. In the real profile the largest text part is 10 KB and the largest reasoning part 21 KB, against a largest turn of 5.5 MB.
- Paging the transcript in SQL (`2026-11-02-paged-transcript.md`). Its size window should read `length(parts)` from the same `coalesce` when it lands.

## Verification

- `scripts/perf/fanout.ts` streams the `long-turn` simulation in 6 threads on a copy of a real profile, and reports message write statements, the main-thread time in them, main-process CPU and the bytes the main process wrote. Compare a build of `main` with this branch.
- `scripts/perf/partsMigration.ts` runs the migration on a copy of a real database and checks that every thread's messages read back identical.
- `Messages.integration.test.ts` covers saving only changed parts, closing, reading a crashed open message, tool output from an open message, and deletion cascade.
