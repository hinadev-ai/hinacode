import { expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import type { MessagePart } from "../../shared/domain.ts"
import * as Messages from "../services/Messages.ts"
import * as Db from "./client.ts"
import messagePart from "./migrations/0037_message_part.ts"
import { seedThread } from "./testing.ts"

const text = (value: string): MessagePart => ({ type: "text", text: value })
const call: MessagePart = { type: "tool_call", callId: "c1", name: "Bash", input: { command: "ls" }, status: "running" }

it.effect("moves only the parts of open messages and reads every message back the same", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const messages = yield* Messages.Messages
    const { threadId } = yield* seedThread({ rootPath: "/repo" })
    yield* sql`DROP TABLE message_part`
    const insert = (id: string, parts: ReadonlyArray<MessagePart>, createdAt: string, completedAt: string | null) =>
      sql`INSERT INTO message ${sql.insert({ id, threadId, role: "assistant", parts: JSON.stringify(parts), createdAt, completedAt })}`
    yield* insert("closed", [text("done")], "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:01.000Z")
    yield* insert("empty", [], "2026-11-01T00:00:02.000Z", null)
    yield* insert("open", [text("a"), call, text("b")], "2026-11-01T00:00:03.000Z", null)

    yield* sql.withTransaction(messagePart)

    const listed = yield* messages.list(threadId)
    expect(listed.map(({ id, parts, completedAt }) => ({ id, parts, completedAt }))).toStrictEqual([
      { id: "closed", parts: [text("done")], completedAt: "2026-11-01T00:00:01.000Z" },
      { id: "empty", parts: [], completedAt: null },
      { id: "open", parts: [text("a"), call, text("b")], completedAt: null },
    ])
    expect(yield* sql`SELECT id, parts FROM message ORDER BY created_at`).toStrictEqual([
      { id: "closed", parts: JSON.stringify([text("done")]) },
      { id: "empty", parts: "[]" },
      { id: "open", parts: "[]" },
    ])
    expect(yield* sql`SELECT message_id, idx FROM message_part ORDER BY idx`).toStrictEqual([
      { messageId: "open", idx: 0 },
      { messageId: "open", idx: 1 },
      { messageId: "open", idx: 2 },
    ])
  }).pipe(Effect.provide(Messages.layer.pipe(Layer.provideMerge(Db.layer(":memory:"))))),
)
