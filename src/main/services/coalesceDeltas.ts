import { Duration, Effect, type Scope } from "effect"
import type { AgentEvent } from "../../shared/agent.ts"

export const DELTA_WINDOW = Duration.millis(50)

type Delta = Extract<AgentEvent, { readonly type: "text_delta" | "reasoning_delta" }>
type OpenWindow = { readonly type: Delta["type"]; held: string }

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
  let open: OpenWindow | undefined

  const publishHeld = (window: OpenWindow) => {
    const text = window.held
    window.held = ""
    return apply({ type: window.type, text })
  }

  const flush = Effect.suspend(() => {
    const window = open
    if (window === undefined) return Effect.void
    open = undefined
    return window.held === "" ? Effect.void : publishHeld(window)
  })

  const publishOrClose = (window: OpenWindow) =>
    Effect.suspend(() => {
      if (open !== window) return Effect.succeed(false)
      if (window.held === "") {
        open = undefined
        return Effect.succeed(false)
      }
      return publishHeld(window).pipe(Effect.as(true))
    })

  const publishEachWindow = (window: OpenWindow): Effect.Effect<void, E, R> =>
    Effect.sleep(DELTA_WINDOW).pipe(
      Effect.andThen(exclusive(publishOrClose(window))),
      Effect.flatMap((stillOpen) => (stillOpen ? publishEachWindow(window) : Effect.void)),
    )

  const closeAfterFailure = (window: OpenWindow) => (error: E) =>
    Effect.logError("failed to publish streamed text", error).pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (open === window) open = undefined
        }),
      ),
    )

  const offer = (event: AgentEvent) =>
    Effect.gen(function* () {
      if (isDelta(event) && open?.type === event.type) {
        open.held += event.text
        return
      }
      yield* flush
      yield* apply(event)
      if (!isDelta(event)) return
      const window: OpenWindow = { type: event.type, held: "" }
      open = window
      yield* Effect.forkIn(publishEachWindow(window).pipe(Effect.catch(closeAfterFailure(window))), scope)
    })

  return { offer, flush }
}
