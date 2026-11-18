import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { backoffMs, retryWhileRecoverable, SlackApiError } from "./api.ts"

const refusal = (fields: Partial<SlackApiError>) =>
  new SlackApiError({ method: "auth.test", reason: "HTTP 429", recoverable: true, retryAfterMs: null, ...fields })

const scripted = (outcomes: ReadonlyArray<SlackApiError | "ok">) => {
  let calls = 0
  const effect = Effect.suspend(() => {
    const outcome = outcomes[calls] ?? "ok"
    calls += 1
    return outcome === "ok" ? Effect.succeed(calls) : Effect.fail(outcome)
  })
  return { effect, calls: () => calls }
}

describe("retryWhileRecoverable", () => {
  it.effect("waits as long as Slack's Retry-After says before asking again", () =>
    Effect.gen(function* () {
      const { effect, calls } = scripted([refusal({ retryAfterMs: 60_000 })])
      const fiber = yield* Effect.forkChild(retryWhileRecoverable(effect))
      yield* TestClock.adjust("59 seconds")
      expect(calls()).toBe(1)
      yield* TestClock.adjust("1 second")
      expect(yield* Fiber.join(fiber)).toBe(2)
    }),
  )

  it.effect("doubles the wait from one second while nothing says how long", () =>
    Effect.gen(function* () {
      const { effect, calls } = scripted([refusal({}), refusal({}), refusal({})])
      const fiber = yield* Effect.forkChild(retryWhileRecoverable(effect))
      yield* TestClock.adjust("1 second")
      expect(calls()).toBe(2)
      yield* TestClock.adjust("2 seconds")
      expect(calls()).toBe(3)
      yield* TestClock.adjust("4 seconds")
      expect(yield* Fiber.join(fiber)).toBe(4)
    }),
  )

  it.effect("gives up at once on an answer that will not change", () =>
    Effect.gen(function* () {
      const { effect, calls } = scripted([refusal({ reason: "invalid_auth", recoverable: false })])
      const error = yield* Effect.flip(retryWhileRecoverable(effect))
      expect(error.reason).toBe("invalid_auth")
      expect(calls()).toBe(1)
    }),
  )

  it("never waits longer than thirty seconds on its own", () => {
    expect([0, 1, 4, 5, 40, 2000].map(backoffMs)).toEqual([1000, 2000, 16_000, 30_000, 30_000, 30_000])
  })
})
