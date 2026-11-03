import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import type { Message, MessagePart, ThreadStatus } from "../../shared/domain.ts"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import * as Messages from "./Messages.ts"

const withMessages = Effect.provide(Messages.layer.pipe(Layer.provideMerge(Db.layer(":memory:"))))

const runningCall: MessagePart = { type: "tool_call", callId: "c1", name: "Bash", input: {}, status: "running" }

const threadWithTurn = (status: ThreadStatus, completedAt: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { threadId } = yield* seedThread({ rootPath: `/repo/${crypto.randomUUID()}` })
    yield* sql`UPDATE thread SET status = ${status} WHERE id = ${threadId}`
    yield* sql`INSERT INTO message ${sql.insert({
      id: `${threadId}-turn`,
      threadId,
      role: "assistant",
      parts: JSON.stringify([runningCall]),
      createdAt: "2026-10-31T00:00:00.000Z",
      completedAt,
    })}`
    return threadId
  })

describe("Messages.closeInterrupted", () => {
  it.effect("closes the turns of threads a quit or crash left running", () =>
    withMessages(
      Effect.gen(function* () {
        const open = yield* threadWithTurn("running", null)
        const steered = yield* threadWithTurn("awaiting_approval", "2026-10-31T00:00:01.000Z")
        const messages = yield* Messages.Messages

        yield* messages.closeInterrupted

        const [closed] = yield* messages.list(open)
        expect(closed?.completedAt).not.toBeNull()
        expect(closed?.parts).toStrictEqual([{ ...runningCall, status: "error" }])
        const [settled] = yield* messages.list(steered)
        expect(settled?.completedAt).toBe("2026-10-31T00:00:01.000Z")
        expect(settled?.parts).toStrictEqual([{ ...runningCall, status: "error" }])
      }),
    ),
  )

  it.effect("closes the open turn of a thread that crashed outside a running status", () =>
    withMessages(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const unstarted = yield* threadWithTurn("idle", null)
        const finishing = yield* threadWithTurn("idle", null)
        yield* sql`INSERT INTO message ${sql.insert({
          id: `${finishing}-steered`,
          threadId: finishing,
          role: "assistant",
          parts: JSON.stringify([runningCall]),
          createdAt: "2026-10-30T23:59:59.000Z",
          completedAt: "2026-10-31T00:00:00.000Z",
        })}`
        const messages = yield* Messages.Messages

        yield* messages.closeInterrupted

        const [closed] = yield* messages.list(unstarted)
        expect(closed?.completedAt).not.toBeNull()
        expect(closed?.parts).toStrictEqual([{ ...runningCall, status: "error" }])
        const [steered, open] = yield* messages.list(finishing)
        expect(steered?.parts).toStrictEqual([{ ...runningCall, status: "error" }])
        expect(open?.completedAt).not.toBeNull()
      }),
    ),
  )
})

const text = (value: string): MessagePart => ({ type: "text", text: value })

const openTurn = (parts: ReadonlyArray<MessagePart>) =>
  Effect.gen(function* () {
    const { threadId } = yield* seedThread({ rootPath: `/repo/${crypto.randomUUID()}` })
    const message: Message = {
      id: `${threadId}-turn`,
      threadId,
      role: "assistant",
      parts,
      createdAt: "2026-11-03T00:00:00.000Z",
      completedAt: null,
      usage: null,
      forkPoint: null,
    }
    yield* (yield* Messages.Messages).insert(message)
    return message
  })

const partRows = (messageId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ idx: number; part: string }>`
      SELECT idx, part FROM message_part WHERE message_id = ${messageId} ORDER BY idx
    `
  })

describe("Messages.update", () => {
  it.effect("saves only the parts of an open message that changed", () =>
    withMessages(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const messages = yield* Messages.Messages
        const previous = yield* openTurn([text("a"), runningCall, text("b")])
        const next: Message = {
          ...previous,
          parts: [previous.parts[0]!, previous.parts[1]!, text("b, longer"), text("c")],
        }
        const tampered = JSON.stringify(text("untouched"))
        yield* sql`UPDATE message_part SET part = ${tampered} WHERE message_id = ${previous.id} AND idx = 0`

        yield* messages.update(next, previous)

        expect(yield* partRows(previous.id)).toStrictEqual([
          { idx: 0, part: tampered },
          { idx: 1, part: JSON.stringify(runningCall) },
          { idx: 2, part: JSON.stringify(text("b, longer")) },
          { idx: 3, part: JSON.stringify(text("c")) },
        ])
        const [saved] = yield* messages.list(previous.threadId)
        expect(saved?.parts).toStrictEqual([text("untouched"), ...next.parts.slice(1)])
        expect(yield* sql`SELECT parts FROM message WHERE id = ${previous.id}`).toStrictEqual([{ parts: "[]" }])
      }),
    ),
  )

  it.effect("moves the parts of a message back into its row when it closes", () =>
    withMessages(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const messages = yield* Messages.Messages
        const previous = yield* openTurn([text("searchable words")])
        const closed: Message = { ...previous, completedAt: "2026-11-03T00:00:01.000Z" }

        yield* messages.update(closed, previous)

        expect(yield* partRows(previous.id)).toStrictEqual([])
        const [row] = yield* sql<{ parts: string }>`SELECT parts FROM message WHERE id = ${previous.id}`
        expect(JSON.parse(row?.parts ?? "null")).toStrictEqual(closed.parts)
        expect(yield* messages.list(previous.threadId)).toStrictEqual([closed])
        const [fts] = yield* sql<{ body: string }>`
          SELECT body FROM message_fts WHERE rowid = (SELECT rowid FROM message WHERE id = ${previous.id})
        `
        expect(fts?.body).toContain("searchable words")
      }),
    ),
  )
})

describe("Messages.toolOutput", () => {
  it.effect("finds the output of a tool call in an open message", () =>
    withMessages(
      Effect.gen(function* () {
        const messages = yield* Messages.Messages
        const message = yield* openTurn([{ ...runningCall, status: "done", output: "done" }])

        expect(yield* messages.toolOutput(message.threadId, "c1")).toStrictEqual(Option.some("done"))
      }),
    ),
  )
})

describe("message_part", () => {
  it.effect("goes away with its thread", () =>
    withMessages(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const message = yield* openTurn([text("a"), text("b")])

        yield* sql`DELETE FROM thread WHERE id = ${message.threadId}`

        expect(yield* partRows(message.id)).toStrictEqual([])
      }),
    ),
  )
})

describe("Messages.closeInterrupted with open parts", () => {
  it.effect("closes an open message whose parts live in message_part", () =>
    withMessages(
      Effect.gen(function* () {
        const messages = yield* Messages.Messages
        const message = yield* openTurn([text("a"), runningCall])

        yield* messages.closeInterrupted

        const [closed] = yield* messages.list(message.threadId)
        expect(closed?.completedAt).not.toBeNull()
        expect(closed?.parts).toStrictEqual([text("a"), { ...runningCall, status: "error" }])
        expect(yield* partRows(message.id)).toStrictEqual([])
      }),
    ),
  )
})
