import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, PubSub, Stream } from "effect"
import { TestClock } from "effect/testing"
import { type Deadline, earliest, runAtDeadlines } from "./deadlines.ts"

const minutes = (count: number) => count * 60_000

const startLoop = (deadlines: Array<Deadline>) =>
  Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<Deadline>()
    const checks: Array<number> = []
    const check = Effect.gen(function* () {
      checks.push(yield* Clock.currentTimeMillis)
      return deadlines.shift()
    })
    const subscription = yield* PubSub.subscribe(changes)
    yield* Effect.forkScoped(runAtDeadlines(check, Stream.fromSubscription(subscription)))
    yield* Effect.yieldNow
    return { checks, change: (at: Deadline) => PubSub.publish(changes, at) }
  })

describe("earliest", () => {
  it("ignores missing and unparsable deadlines", () => {
    expect(earliest([undefined, Number.NaN, 30, 10, 20])).toBe(10)
    expect(earliest([undefined, Number.NaN])).toBeUndefined()
  })
})

describe("runAtDeadlines", () => {
  it.effect("checks once and then sleeps while nothing has a deadline", () =>
    Effect.gen(function* () {
      const { checks } = yield* startLoop([])
      yield* TestClock.adjust("1 hour")
      expect(checks).toEqual([0])
    }).pipe(Effect.scoped),
  )

  it.effect("checks again at the deadline and not before", () =>
    Effect.gen(function* () {
      const { checks } = yield* startLoop([minutes(10)])
      yield* TestClock.adjust("9 minutes")
      expect(checks).toEqual([0])
      yield* TestClock.adjust("1 minute")
      expect(checks).toEqual([0, minutes(10)])
    }).pipe(Effect.scoped),
  )

  it.effect("wakes for a change that brings a sooner deadline and ignores a later one", () =>
    Effect.gen(function* () {
      const { checks, change } = yield* startLoop([minutes(10), minutes(2)])
      yield* TestClock.adjust("1 minute")
      yield* change(minutes(20))
      yield* change(undefined)
      yield* Effect.yieldNow
      expect(checks).toEqual([0])
      yield* change(minutes(2))
      yield* Effect.yieldNow
      expect(checks).toEqual([0, minutes(1)])
      yield* TestClock.adjust("1 minute")
      expect(checks).toEqual([0, minutes(1), minutes(2)])
    }).pipe(Effect.scoped),
  )

  it.effect("rechecks an overdue deadline once a second until it clears", () =>
    Effect.gen(function* () {
      const { checks } = yield* startLoop([0, 0])
      yield* TestClock.adjust("1 hour")
      expect(checks).toEqual([0, 1000, 2000])
    }).pipe(Effect.scoped),
  )

  it.effect("does not miss a change that lands while it checks", () =>
    Effect.gen(function* () {
      const { checks, change } = yield* startLoop([undefined])
      yield* change(minutes(5))
      yield* TestClock.adjust("1 second")
      expect(checks).toEqual([0, 1000])
    }).pipe(Effect.scoped),
  )
})
