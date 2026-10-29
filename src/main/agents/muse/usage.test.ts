import { describe, expect, it, test } from "@effect/vitest"
import { Effect } from "effect"
import { MuseCallError } from "./host.ts"
import type { ViewPage } from "./protocol.ts"
import { completionTokens, makeSessionUsage } from "./usage.ts"

const usage = (prompt: number, output: number, cache: { read?: number; write?: number; cached?: number } = {}) => ({
  modelId: "muse-wonder-full-1.0",
  promptTokens: prompt,
  usage: {
    cacheReadTokens: cache.read ?? 0,
    cacheWriteTokens: cache.write ?? 0,
    cachedTokens: cache.cached ?? 0,
    inputTokens: prompt,
    outputTokens: output,
    reasoningTokens: 0,
  },
})

describe("completionTokens", () => {
  test("bills the prompt at the full rate less what the cache read and wrote", () => {
    expect(completionTokens(usage(28865, 16))).toStrictEqual({
      inputTokens: 28865,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 16,
    })
    expect(completionTokens(usage(30000, 40, { read: 20000, write: 4000 }))).toStrictEqual({
      inputTokens: 6000,
      cacheWriteTokens: 4000,
      cacheReadTokens: 20000,
      outputTokens: 40,
    })
  })

  test("reads the cache from cachedTokens when the provider reports no cache reads", () => {
    const openAiStyle = { modelId: null, promptTokens: 1000, usage: { cachedTokens: 600, outputTokens: 5 } }
    expect(completionTokens(openAiStyle)).toStrictEqual({
      inputTokens: 400,
      cacheWriteTokens: 0,
      cacheReadTokens: 600,
      outputTokens: 5,
    })
  })
})

type Event = { readonly method: string; readonly params: { readonly viewCursor: string } & Record<string, unknown> }

const fakeHost = (sessions: Record<string, Array<Event>>, missing: ReadonlySet<string>) => {
  const calls: Array<{ sessionId: string; cursor: string | undefined }> = []
  const page = ({ sessionId, cursor }: { sessionId: string; cursor?: string; limit: number }) =>
    Effect.suspend(() => {
      calls.push({ sessionId, cursor })
      const events = sessions[sessionId]
      if (missing.has(sessionId) || events === undefined) {
        return Effect.fail(
          new MuseCallError({ method: "view/page", kind: "sessionNotFound", message: `no session ${sessionId}` }),
        )
      }
      const start = cursor === undefined ? 0 : events.findIndex((event) => event.params.viewCursor === cursor) + 1
      const slice = events.slice(start, start + 2)
      const more = start + 2 < events.length
      return Effect.succeed<ViewPage>({ events: slice, nextCursor: more ? slice.at(-1)!.params.viewCursor : null })
    })
  return { page, calls }
}

const tokenUsage = (viewCursor: string, prompt: number, output: number): Event => ({
  method: "session/tokenUsage",
  params: { viewCursor, sessionId: "s", ...usage(prompt, output) },
})
const child = (viewCursor: string, childSessionId: string): Event => ({
  method: "item/completed",
  params: {
    viewCursor,
    item: { kind: "reminderChild", childSessionId, itemId: "i", revision: 1, status: "completed" },
  },
})
const other = (viewCursor: string): Event => ({ method: "item/delta", params: { viewCursor, delta: "hi" } })

describe("makeSessionUsage", () => {
  it.effect("sums the root session and its children across pages, skipping a child with no log", () =>
    Effect.gen(function* () {
      const sessions = {
        root: [
          tokenUsage("r1", 1000, 10),
          child("r2", "reminder"),
          other("r3"),
          child("r4", "gone"),
          tokenUsage("r5", 2000, 20),
        ],
        reminder: [tokenUsage("c1", 300, 3)],
      }
      const host = fakeHost(sessions, new Set(["gone"]))
      const read = makeSessionUsage(host.page)

      expect(yield* read("root")).toStrictEqual({
        models: [
          {
            model: "muse-wonder-full-1.0",
            inputTokens: 3300,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 33,
          },
        ],
        transcripts: 2,
      })
      expect(host.calls.filter((call) => call.sessionId === "root").map((call) => call.cursor)).toStrictEqual([
        undefined,
        "r2",
        "r4",
      ])

      sessions.root.push(tokenUsage("r6", 500, 5))
      sessions.reminder.push(tokenUsage("c2", 100, 1))
      host.calls.length = 0

      expect((yield* read("root"))?.models[0]).toMatchObject({ inputTokens: 3900, outputTokens: 39 })
      expect(host.calls).toStrictEqual([
        { sessionId: "root", cursor: "r5" },
        { sessionId: "gone", cursor: undefined },
        { sessionId: "reminder", cursor: "c1" },
      ])
    }),
  )

  it.effect("counts a child that two events name once", () =>
    Effect.gen(function* () {
      const host = fakeHost(
        { root: [child("r1", "kid"), child("r2", "kid")], kid: [tokenUsage("k1", 10, 1)] },
        new Set(),
      )
      expect((yield* makeSessionUsage(host.page)("root"))?.transcripts).toBe(2)
    }),
  )

  it.effect("is null when the root session has no log", () =>
    Effect.gen(function* () {
      const host = fakeHost({}, new Set())
      expect(yield* makeSessionUsage(host.page)("root")).toBeNull()
    }),
  )

  it.effect("fails on any other error", () =>
    Effect.gen(function* () {
      const read = makeSessionUsage(() =>
        Effect.fail(new MuseCallError({ method: "view/page", kind: "timeout", message: "slow" })),
      )
      expect((yield* read("root").pipe(Effect.flip)).message).toBe("slow")
    }),
  )
})
