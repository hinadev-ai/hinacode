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
  it.effect("publishes many deltas inside one window as one joined delta", () =>
    Effect.gen(function* () {
      const { applied, offer } = yield* makeProbe
      const chunks = Array.from({ length: 300 }, (_, index) => `w${index} `)
      for (const chunk of chunks) yield* offer(text(chunk))
      expect(applied).toEqual([])

      yield* TestClock.adjust(DELTA_WINDOW)
      expect(applied).toEqual([text(chunks.join(""))])
    }).pipe(Effect.scoped),
  )

  it.effect("starts a new window for deltas after a flush", () =>
    Effect.gen(function* () {
      const { applied, offer } = yield* makeProbe
      yield* offer(text("one "))
      yield* TestClock.adjust(DELTA_WINDOW)
      yield* offer(text("two "))
      yield* offer(text("three"))
      yield* TestClock.adjust(DELTA_WINDOW)
      expect(applied).toEqual([text("one "), text("two three")])
    }).pipe(Effect.scoped),
  )

  it.effect("publishes pending text before any other event", () =>
    Effect.gen(function* () {
      const { applied, offer } = yield* makeProbe
      yield* offer(text("Let me "))
      yield* offer(text("check."))
      yield* offer(toolCall)
      yield* offer(text("Done."))
      expect(applied).toEqual([text("Let me check."), toolCall])

      yield* TestClock.adjust(DELTA_WINDOW)
      expect(applied).toEqual([text("Let me check."), toolCall, text("Done.")])
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
      expect(applied).toEqual([reasoning("think more"), text("answer"), reasoning("again")])
    }).pipe(Effect.scoped),
  )

  it.effect("publishes a flushed batch once even when its window ends later", () =>
    Effect.gen(function* () {
      const { applied, offer, flush } = yield* makeProbe
      yield* offer(text("before steer"))
      yield* flush
      yield* flush
      expect(applied).toEqual([text("before steer")])

      yield* TestClock.adjust(DELTA_WINDOW)
      expect(applied).toEqual([text("before steer")])
    }).pipe(Effect.scoped),
  )
})
