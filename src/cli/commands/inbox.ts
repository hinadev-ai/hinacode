import { Effect, Schema } from "effect"
import { Command } from "effect/cli"
import type { Thread } from "../../shared/domain.ts"
import { Ask, asksFrom } from "../asks.ts"
import type { Client } from "../client.ts"
import { emit, encode, succeed, withClient } from "../session.ts"

const InboxSnapshot = Schema.Struct({ asks: Schema.Array(Ask), running: Schema.Number, idle: Schema.Number })

const countStatus = (threads: ReadonlyArray<Thread>, status: Thread["status"]) =>
  threads.filter((thread) => thread.sideOf === null && thread.status === status).length

export const loadInbox = (client: Client) =>
  Effect.gen(function* () {
    const threads = yield* client.call("threads.list", undefined)
    const waiting = threads.filter((thread) => thread.status === "awaiting_approval")
    const transcripts = yield* Effect.forEach(
      waiting,
      (thread) =>
        Effect.map(
          client.call("threads.transcript", { threadId: thread.id, compact: true }),
          (transcript) => [thread.id, transcript] as const,
        ),
      { concurrency: 4 },
    )
    return {
      asks: asksFrom(threads, new Map(transcripts)),
      running: countStatus(threads, "running"),
      idle: countStatus(threads, "idle"),
    } satisfies typeof InboxSnapshot.Type
  })

export const inbox = Command.make("inbox", {}, () =>
  emit(
    withClient((client) =>
      Effect.gen(function* () {
        return succeed(yield* encode(InboxSnapshot, yield* loadInbox(client)))
      }),
    ),
  ),
).pipe(
  Command.withDescription(
    "Print what waits on a human: open approvals, questions and secret requests, limited threads, and how many threads run or idle.",
  ),
)
