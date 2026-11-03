import { describe, expect, it } from "@effect/vitest"
import { Effect, Logger } from "effect"
import { TestClock } from "effect/testing"
import { SpanLedger, traceLayer } from "./trace.ts"
import { type DelayHistogram, STALL_MS, watchdogLayer } from "./watchdog.ts"

const fakeHistogram = () => {
  const delays = {
    max: 0,
    stall: (ms: number) => {
      delays.max = ms * 1e6
    },
    reset: () => {
      delays.max = 0
    },
    enable: () => true,
    disable: () => true,
  } satisfies DelayHistogram & { stall: (ms: number) => void }
  return delays
}

const watched = <A, E>(body: (delays: ReturnType<typeof fakeHistogram>) => Effect.Effect<A, E>) => {
  const logs: Array<string> = []
  const ledger = new SpanLedger(STALL_MS)
  const delays = fakeHistogram()
  return body(delays).pipe(
    Effect.provide(watchdogLayer(ledger, delays)),
    Effect.provide(traceLayer(undefined, ledger)),
    Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(String(message)))])),
    Effect.as(logs),
  )
}

describe("watchdogLayer", () => {
  it.effect("names the slow spans around a stall, closest to its length first", () =>
    Effect.gen(function* () {
      const logs = yield* watched((delays) =>
        Effect.gen(function* () {
          yield* Effect.sleep("5 seconds").pipe(Effect.withSpan("exec git"), Effect.forkChild)
          yield* Effect.sleep("50 millis").pipe(Effect.withSpan("sql fast"), Effect.forkChild)
          yield* Effect.sleep("1838 millis").pipe(
            Effect.withSpan("sql", { attributes: { "db.query.text": "SELECT *\n  FROM messages" } }),
            Effect.andThen(Effect.sleep("3 millis")),
            Effect.withSpan("rpc messages.page"),
            Effect.forkChild,
          )
          yield* TestClock.adjust("1 second")
          delays.stall(1840)
          yield* TestClock.adjust("1 second")
        }),
      )
      expect(logs).toEqual([
        "main event loop stalled for 1840ms, spans open around it: rpc messages.page (1841ms), sql SELECT * FROM messages (1838ms), exec git (2000ms)",
      ])
    }),
  )

  it.effect("ignores delays under the threshold", () =>
    Effect.gen(function* () {
      const logs = yield* watched((delays) =>
        Effect.gen(function* () {
          delays.stall(STALL_MS - 1)
          yield* TestClock.adjust("1 second")
        }),
      )
      expect(logs).toEqual([])
    }),
  )

  it.effect("reports five stalls a minute and counts the rest when the window rolls", () =>
    Effect.gen(function* () {
      const logs = yield* watched((delays) =>
        Effect.gen(function* () {
          for (let second = 0; second < 7; second++) {
            delays.stall(300)
            yield* TestClock.adjust("1 second")
          }
          yield* TestClock.adjust("1 minute")
        }),
      )
      expect(logs).toEqual([
        ...Array.from({ length: 5 }, () => "main event loop stalled for 300ms"),
        "main event loop watchdog suppressed 2 stalls",
      ])
    }),
  )
})
