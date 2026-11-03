#!/usr/bin/env node
import { deepStrictEqual } from "node:assert/strict"
import { copyFileSync, rmSync } from "node:fs"
import { performance } from "node:perf_hooks"
import { DatabaseSync } from "node:sqlite"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { ForkPoint, TokenUsage } from "../../src/shared/agent.ts"
import { MessagePart } from "../../src/shared/domain.ts"
import * as Db from "../../src/main/db/client.ts"
import * as Messages from "../../src/main/services/Messages.ts"

type Row = {
  thread_id: string
  id: string
  role: string
  parts: string
  created_at: string
  completed_at: string | null
  usage: string | null
  fork_point: string | null
}

const source = process.argv[2]
if (source === undefined) throw new Error("usage: partsMigration.ts <copy-of-hinacode.sqlite>")
const migrated = `${source}.migrated`
for (const suffix of ["", "-wal", "-shm"]) rmSync(`${migrated}${suffix}`, { force: true })
copyFileSync(source, migrated)

const decodeParts = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(MessagePart)))
const decodeUsage = Schema.decodeUnknownSync(Schema.NullOr(Schema.fromJsonString(TokenUsage)))
const decodeForkPoint = Schema.decodeUnknownSync(Schema.NullOr(Schema.fromJsonString(ForkPoint)))

const before = new DatabaseSync(source, { readOnly: true })
const openBefore = before.prepare("SELECT count(*) AS n FROM message WHERE completed_at IS NULL").get()!["n"]
const rowsOf = before.prepare("SELECT * FROM message WHERE thread_id = ? ORDER BY created_at, rowid")
const threadIds = before
  .prepare("SELECT DISTINCT thread_id FROM message")
  .all()
  .map((row) => String(row["thread_id"]))

const runtime = ManagedRuntime.make(
  Messages.layer.pipe(Layer.provideMerge(Db.layer(migrated)), Layer.provideMerge(NodeServices.layer)),
)
const startedAt = performance.now()
const messages = await runtime.runPromise(
  Effect.gen(function* () {
    return yield* Messages.Messages
  }),
)
const migrationMs = performance.now() - startedAt

let messageCount = 0
for (const threadId of threadIds) {
  const expected = (rowsOf.all(threadId) as Array<Row>).map((row) => ({
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    parts: decodeParts(row.parts),
    createdAt: row.created_at,
    completedAt: row.completed_at,
    usage: decodeUsage(row.usage),
    forkPoint: decodeForkPoint(row.fork_point),
  }))
  const actual = await runtime.runPromise(messages.list(threadId))
  deepStrictEqual(
    actual.map(({ id, threadId: thread, role, parts, createdAt, completedAt, usage, forkPoint }) => ({
      id,
      threadId: thread,
      role,
      parts,
      createdAt,
      completedAt,
      usage,
      forkPoint,
    })),
    expected,
    `thread ${threadId} reads back identical`,
  )
  messageCount += expected.length
}
await runtime.dispose()
before.close()

const after = new DatabaseSync(migrated, { readOnly: true })
const partRows = after.prepare("SELECT count(*) AS n FROM message_part").get()!["n"]
after.close()

console.log(
  JSON.stringify({
    threads: threadIds.length,
    messages: messageCount,
    openMessages: openBefore,
    movedPartRows: partRows,
    migrationMs: Math.round(migrationMs),
  }),
)
