import { Effect, FiberSet, Layer, PubSub, Schedule } from "effect"
import { EventBus } from "./EventBus.ts"
import { PullRequestLifecycle } from "./PullRequestLifecycle.ts"

const SWEEP_INTERVAL = "3 minutes"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* EventBus
    const lifecycle = yield* PullRequestLifecycle

    const subscription = yield* PubSub.subscribe(bus)
    const reactions = yield* FiberSet.make()
    yield* PubSub.take(subscription).pipe(
      Effect.flatMap((event) =>
        FiberSet.run(
          reactions,
          lifecycle
            .announce(event)
            .pipe(Effect.catchCause((cause) => Effect.logWarning("reaction failed", event.topic, cause))),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    )
    yield* Effect.schedule(lifecycle.sweep, Schedule.spaced(SWEEP_INTERVAL)).pipe(Effect.forkScoped)
  }),
)
