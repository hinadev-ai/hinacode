import { Context, Effect, Layer, Schema, type Scope } from "effect"
import { PushEvent } from "../../shared/contract.ts"

export class Events extends Context.Service<Events, { readonly publish: (event: PushEvent) => Effect.Effect<void> }>()(
  "hinacode/Events",
) {}

type Sink = (event: typeof PushEvent.Encoded) => void

interface Broadcast {
  readonly subscribe: (sink: Sink) => Effect.Effect<void, never, Scope.Scope>
}

export class PushBroadcast extends Context.Service<PushBroadcast, Broadcast>()("hinacode/PushBroadcast") {}

export class WindowBroadcast extends Context.Service<WindowBroadcast, Broadcast>()("hinacode/WindowBroadcast") {}

export class WindowPush extends Context.Service<
  WindowPush,
  { readonly send: (event: PushEvent) => Effect.Effect<void> }
>()("hinacode/WindowPush") {}

const encodePushEvent = Schema.encodeSync(PushEvent)

const subscribeTo =
  (sinks: Set<Sink>): Broadcast["subscribe"] =>
  (sink) =>
    Effect.acquireRelease(
      Effect.sync(() => void sinks.add(sink)),
      () => Effect.sync(() => void sinks.delete(sink)),
    )

export const makeEventsLayer = (toWindows: Sink) => {
  const sinks = new Set<Sink>()
  const windowSinks = new Set<Sink>()
  const toEveryWindow = (encoded: typeof PushEvent.Encoded) => {
    toWindows(encoded)
    for (const sink of windowSinks) sink(encoded)
  }
  const events = Layer.succeed(
    Events,
    Events.of({
      publish: (event) =>
        Effect.sync(() => {
          const encoded = encodePushEvent(event)
          toEveryWindow(encoded)
          for (const sink of sinks) sink(encoded)
        }),
    }),
  )
  const windows = Layer.succeed(
    WindowPush,
    WindowPush.of({ send: (event) => Effect.sync(() => toEveryWindow(encodePushEvent(event))) }),
  )
  return Layer.mergeAll(
    events,
    windows,
    Layer.succeed(PushBroadcast, PushBroadcast.of({ subscribe: subscribeTo(sinks) })),
    Layer.succeed(WindowBroadcast, WindowBroadcast.of({ subscribe: subscribeTo(windowSinks) })),
  )
}
