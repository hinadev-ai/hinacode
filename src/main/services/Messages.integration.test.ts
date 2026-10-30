import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import type { MessagePart, ThreadStatus } from "../../shared/domain.ts"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import * as Messages from "./Messages.ts"

const withMessages = Effect.provide(Messages.layer.pipe(Layer.provideMerge(Db.layer(":memory:"))))

const runningCall: MessagePart = { type: "tool_call", callId: "c1", name: "Bash", input: {}, status: "running" }

const threadWithTurn = (status: ThreadStatus, completedAt: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { threadId } = yield* seedThread({ rootPath: `/repo/${status}/${completedAt}` })
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
})
