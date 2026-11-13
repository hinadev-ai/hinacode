import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import type { ProviderId } from "../../shared/agent.ts"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import * as Usage from "./Usage.ts"

const withUsage = Effect.provide(Usage.layer.pipe(Layer.provideMerge(Db.layer(":memory:"))))

const thread = (provider: ProviderId, model: string, projectId?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const seeded = yield* seedThread({ rootPath: `/repo/${crypto.randomUUID()}`, ...(projectId ? { projectId } : {}) })
    yield* sql`UPDATE thread SET provider = ${provider}, model = ${model} WHERE id = ${seeded.threadId}`
    return seeded
  })

const turn = (threadId: string, at: string, tokens: { inputTokens: number; outputTokens: number } | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO message ${sql.insert({
      id: crypto.randomUUID(),
      threadId,
      role: "user",
      parts: "[]",
      createdAt: at,
      completedAt: at,
    })}`
    yield* sql`INSERT INTO message ${sql.insert({
      id: crypto.randomUUID(),
      threadId,
      role: "assistant",
      parts: "[]",
      createdAt: at,
      completedAt: at,
      usage: tokens === null ? null : JSON.stringify(tokens),
    })}`
  })

const agentSwitch = (threadId: string, at: string, from: ProviderId, to: ProviderId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO message ${sql.insert({
      id: crypto.randomUUID(),
      threadId,
      role: "assistant",
      parts: JSON.stringify([{ type: "agent_switch", from, to }]),
      createdAt: at,
      completedAt: at,
    })}`
  })

describe("Usage.rows", () => {
  it.effect("counts the prompts and tokens of each thread since the period start", () =>
    withUsage(
      Effect.gen(function* () {
        const { threadId, projectId } = yield* thread("codex", "gpt-6.1-sol")
        yield* turn(threadId, "2026-10-01T00:00:00.000Z", { inputTokens: 900, outputTokens: 100 })
        yield* turn(threadId, "2026-11-10T00:00:00.000Z", { inputTokens: 40, outputTokens: 10 })
        yield* turn(threadId, "2026-11-11T00:00:00.000Z", null)
        const usage = yield* Usage.Usage

        expect(yield* usage.rows("2026-11-06T00:00:00.000Z")).toStrictEqual([
          { threadId, projectId, projectName: "demo", provider: "codex", model: "gpt-6.1-sol", turns: 2, tokens: 50 },
        ])
        expect(yield* usage.rows(null)).toMatchObject([{ turns: 3, tokens: 1050 }])
        expect(yield* usage.rows("2026-11-12T00:00:00.000Z")).toStrictEqual([])
      }),
    ),
  )

  it.effect("gives each turn to the agent that ran it when a thread switched agents", () =>
    withUsage(
      Effect.gen(function* () {
        const { threadId } = yield* thread("claude", "claude-opus-5-5")
        yield* turn(threadId, "2026-11-01T00:00:00.000Z", { inputTokens: 10, outputTokens: 1 })
        yield* agentSwitch(threadId, "2026-11-02T00:00:00.000Z", "codex", "muse")
        yield* turn(threadId, "2026-11-03T00:00:00.000Z", { inputTokens: 20, outputTokens: 2 })
        yield* agentSwitch(threadId, "2026-11-04T00:00:00.000Z", "muse", "claude")
        yield* turn(threadId, "2026-11-05T00:00:00.000Z", { inputTokens: 30, outputTokens: 3 })
        const usage = yield* Usage.Usage

        const rows = yield* usage.rows(null)

        expect(rows.map(({ provider, model, turns, tokens }) => ({ provider, model, turns, tokens }))).toStrictEqual(
          expect.arrayContaining([
            { provider: "codex", model: null, turns: 1, tokens: 11 },
            { provider: "muse", model: null, turns: 1, tokens: 22 },
            { provider: "claude", model: "claude-opus-5-5", turns: 1, tokens: 33 },
          ]),
        )
        expect(rows).toHaveLength(3)
      }),
    ),
  )
})
