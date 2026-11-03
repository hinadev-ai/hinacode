import { Clock, Duration, Effect, Stream } from "effect"

export type Deadline = number | undefined

// FIXME: a timer does not count the time the machine spends suspended, so naps are capped and rechecked against the wall clock
const longestNap = Duration.minutes(1)
export const shortestGap = Duration.seconds(1)

const isSooner = (at: Deadline, than: Deadline) =>
  at !== undefined && Number.isFinite(at) && (than === undefined || at < than)

export const earliest = (deadlines: Iterable<Deadline>): Deadline => {
  let first: Deadline
  for (const at of deadlines) if (isSooner(at, first)) first = at
  return first
}

const sleepUntil = (deadline: Deadline) =>
  deadline === undefined
    ? Effect.never
    : Effect.gen(function* () {
        for (let now = yield* Clock.currentTimeMillis; now < deadline; now = yield* Clock.currentTimeMillis) {
          yield* Effect.sleep(Duration.min(Duration.millis(deadline - now), longestNap))
        }
      })

export const runAtDeadlines = <R>(check: Effect.Effect<Deadline, never, R>, changes: Stream.Stream<Deadline>) =>
  Effect.gen(function* () {
    const deadline = yield* check
    yield* Effect.sleep(shortestGap)
    const sooner = changes.pipe(
      Stream.filter((at) => isSooner(at, deadline)),
      Stream.take(1),
      Stream.runDrain,
    )
    yield* Effect.raceFirst(sleepUntil(deadline), sooner)
  }).pipe(Effect.forever)
