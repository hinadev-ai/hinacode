import { Duration, Effect, type Scope } from "effect"
import type { AgentEvent } from "../../shared/agent.ts"

export const DELTA_WINDOW = Duration.millis(50)

type Delta = Extract<AgentEvent, { readonly type: "text_delta" | "reasoning_delta" }>
type PendingDelta = { readonly type: Delta["type"]; text: string }

const isDelta = (event: AgentEvent): event is Delta => event.type === "text_delta" || event.type === "reasoning_delta"

export const makeDeltaCoalescer = <E, R>({
  apply,
  exclusive,
  scope,
}: {
  readonly apply: (event: AgentEvent) => Effect.Effect<void, E, R>
  readonly exclusive: <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) => Effect.Effect<A, E2, R2>
  readonly scope: Scope.Scope
}) => {
  let pending: PendingDelta | undefined

  const flush = Effect.suspend(() => {
    const delta = pending
    if (delta === undefined) return Effect.void
    pending = undefined
    return apply({ type: delta.type, text: delta.text })
  })

  const flushAfterWindow = (batch: PendingDelta) =>
    Effect.sleep(DELTA_WINDOW).pipe(
      Effect.andThen(exclusive(Effect.suspend(() => (pending === batch ? flush : Effect.void)))),
      Effect.catch((error) => Effect.logError("failed to publish streamed text", error)),
    )

  const offer = (event: AgentEvent) =>
    Effect.gen(function* () {
      if (!isDelta(event)) {
        yield* flush
        return yield* apply(event)
      }
      if (pending?.type === event.type) {
        pending.text += event.text
        return
      }
      yield* flush
      const batch: PendingDelta = { type: event.type, text: event.text }
      pending = batch
      yield* Effect.forkIn(flushAfterWindow(batch), scope)
    })

  return { offer, flush }
}
