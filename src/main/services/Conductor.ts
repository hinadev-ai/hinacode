import { Effect, FiberSet, Layer, PubSub, Schedule } from "effect"
import { Automations } from "./automations/Automations.ts"
import { type BusEvent, EventBus } from "./EventBus.ts"
import { PullRequestLifecycle } from "./PullRequestLifecycle.ts"

const SWEEP_INTERVAL = "3 minutes"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* EventBus
    const lifecycle = yield* PullRequestLifecycle
    const automations = yield* Automations

    const react = (event: BusEvent): Effect.Effect<void> => {
      switch (event.topic) {
        case "pullRequest.linked":
          return lifecycle.announce(event)
        case "pullRequest.opened":
        case "pullRequest.merged":
        case "pullRequest.closed":
          return automations.firePullRequest(event)
      }
    }

    const subscription = yield* PubSub.subscribe(bus)
    const reactions = yield* FiberSet.make()
    yield* PubSub.take(subscription).pipe(
      Effect.flatMap((event) =>
        FiberSet.run(
          reactions,
          react(event).pipe(Effect.catchCause((cause) => Effect.logWarning("reaction failed", event.topic, cause))),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    )
    yield* Effect.schedule(lifecycle.sweep, Schedule.spaced(SWEEP_INTERVAL)).pipe(Effect.forkScoped)
  }),
)
