import { describe, expect, it } from "@effect/vitest"
import { Effect, Semaphore } from "effect"
import { TestClock } from "effect/testing"
import type { AgentEvent } from "../../shared/agent.ts"
import { DELTA_WINDOW, makeDeltaCoalescer } from "./coalesceDeltas.ts"

const makeProbe = Effect.gen(function* () {
  const applied: Array<AgentEvent> = []
  const lock = Semaphore.makeUnsafe(1)
  const exclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) => Semaphore.withPermit(lock, effect)
  const coalescer = makeDeltaCoalescer({
    apply: (event) => Effect.sync(() => void applied.push(event)),
    exclusive,
    scope: yield* Effect.scope,
  })
  const offer = (event: AgentEvent) => exclusive(coalescer.offer(event))
  return { applied, offer, flush: exclusive(coalescer.flush) }
})

const text = (value: string): AgentEvent => ({ type: "text_delta", text: value })
const reasoning = (value: string): AgentEvent => ({ type: "reasoning_delta", text: value })
const toolCall: AgentEvent = { type: "tool_call_started", callId: "call-1", name: "Bash", input: {} }

describe("makeDeltaCoalescer", () => {
  it.effect("publishes the first delta at once and the rest of its window as one joined delta", () =>
    Effect.gen(function* () {
      const { applied, offer } = yield* makeProbe
      const chunks = Array.from({ length: 300 }, (_, index) => `w${index} `)
      for (const chunk of chunks) yield* offer(text(chunk))
      expect(applied).toEqual([text("w0 ")])

      yield* TestClock.adjust(DELTA_WINDOW)
      expect(applied).toEqual([text("w0 "), text(chunks.slice(1).join(""))])
    }).pipe(Effect.scoped),
  )

  it.effect("publishes at most once per window while text keeps streaming", () =>
    Effect.gen(function* () {
      const { applied, offer } = yield* makeProbe
      for (let tick = 0; tick < 20; tick++) {
        yield* offer(text(`${tick} `))
        yield* TestClock.adjust("10 millis")
      }
      expect(applied).toEqual([
        text("0 "),
        text("1 2 3 4 "),
        text("5 6 7 8 9 "),
        text("10 11 12 13 14 "),
        text("15 16 17 18 19 "),
      ])
    }).pipe(Effect.scoped),
  )

  it.effect("publishes the first delta after a quiet window at once", () =>
    Effect.gen(function* () {
      const { applied, offer } = yield* makeProbe
      yield* offer(text("one "))
      yield* TestClock.adjust(DELTA_WINDOW)
      yield* offer(text("two "))
      yield* offer(text("three"))
      expect(applied).toEqual([text("one "), text("two ")])

      yield* TestClock.adjust(DELTA_WINDOW)
      expect(applied).toEqual([text("one "), text("two "), text("three")])
    }).pipe(Effect.scoped),
  )

  it.effect("publishes held text before any other event, and the first delta after it at once", () =>
    Effect.gen(function* () {
      const { applied, offer } = yield* makeProbe
      yield* offer(text("Let me "))
      yield* offer(text("check."))
      yield* offer(toolCall)
      yield* offer(text("Done."))
      expect(applied).toEqual([text("Let me "), text("check."), toolCall, text("Done.")])

      yield* TestClock.adjust(DELTA_WINDOW)
      expect(applied).toEqual([text("Let me "), text("check."), toolCall, text("Done.")])
    }).pipe(Effect.scoped),
  )

  it.effect("keeps reasoning and reply text in the order they streamed", () =>
    Effect.gen(function* () {
      const { applied, offer } = yield* makeProbe
      yield* offer(reasoning("think "))
      yield* offer(reasoning("more"))
      yield* offer(text("answer"))
      yield* offer(reasoning("again"))
      yield* TestClock.adjust(DELTA_WINDOW)
      expect(applied).toEqual([reasoning("think "), reasoning("more"), text("answer"), reasoning("again")])
    }).pipe(Effect.scoped),
  )

  it.effect("publishes held text once even when its window ends later", () =>
    Effect.gen(function* () {
      const { applied, offer, flush } = yield* makeProbe
      yield* offer(text("before "))
      yield* offer(text("steer"))
      yield* flush
      yield* flush
      expect(applied).toEqual([text("before "), text("steer")])

      yield* TestClock.adjust(DELTA_WINDOW)
      expect(applied).toEqual([text("before "), text("steer")])
    }).pipe(Effect.scoped),
  )
})
