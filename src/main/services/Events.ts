import { Context, Effect, Layer, Schema, type Scope } from "effect"
import { PushEvent } from "../../shared/contract.ts"

/** Main -> renderer pushes, sent to every open window and every `PushBroadcast` sink. */
export class Events extends Context.Service<Events, { readonly publish: (event: PushEvent) => Effect.Effect<void> }>()(
  "hinacode/Events",
) {}

/** The encoded pushes, for a second transport. Releasing the scope unsubscribes. */
export class PushBroadcast extends Context.Service<
  PushBroadcast,
  { readonly subscribe: (sink: (event: typeof PushEvent.Encoded) => void) => Effect.Effect<void, never, Scope.Scope> }
>()("hinacode/PushBroadcast") {}

/** Sends a push to the desktop windows only, never to `PushBroadcast` sinks. For a cloud's pushes. */
export class WindowPush extends Context.Service<
  WindowPush,
  { readonly send: (event: PushEvent) => Effect.Effect<void> }
>()("hinacode/WindowPush") {}

const encodePushEvent = Schema.encodeSync(PushEvent)

/**
 * Pushes go to `toWindows` and to every sink the remote listener registered. The desktop passes its window
 * sender (`sendToWindows` in `ipc.ts`); a cloud has no windows.
 */
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
