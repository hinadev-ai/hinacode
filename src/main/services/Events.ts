import { Context, Effect, Layer, Schema, type Scope } from "effect"
import { PushEvent } from "../../shared/contract.ts"

export class Events extends Context.Service<Events, { readonly publish: (event: PushEvent) => Effect.Effect<void> }>()(
  "hinacode/Events",
) {}

export class PushBroadcast extends Context.Service<
  PushBroadcast,
  { readonly subscribe: (sink: (event: typeof PushEvent.Encoded) => void) => Effect.Effect<void, never, Scope.Scope> }
>()("hinacode/PushBroadcast") {}

export class WindowPush extends Context.Service<
  WindowPush,
  { readonly send: (event: PushEvent) => Effect.Effect<void> }
>()("hinacode/WindowPush") {}

const encodePushEvent = Schema.encodeSync(PushEvent)

export const makeEventsLayer = (toWindows: (event: typeof PushEvent.Encoded) => void) => {
  const sinks = new Set<(event: typeof PushEvent.Encoded) => void>()
  const events = Layer.succeed(
    Events,
    Events.of({
      publish: (event) =>
        Effect.sync(() => {
          const encoded = encodePushEvent(event)
          toWindows(encoded)
          for (const sink of sinks) sink(encoded)
        }),
    }),
  )
  const windows = Layer.succeed(
    WindowPush,
    WindowPush.of({ send: (event) => Effect.sync(() => toWindows(encodePushEvent(event))) }),
  )
  const broadcast = Layer.succeed(
    PushBroadcast,
    PushBroadcast.of({
      subscribe: (sink) =>
        Effect.acquireRelease(
          Effect.sync(() => void sinks.add(sink)),
          () => Effect.sync(() => void sinks.delete(sink)),
        ),
    }),
  )
  return Layer.mergeAll(events, windows, broadcast)
}
