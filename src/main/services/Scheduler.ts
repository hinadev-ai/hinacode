import { Clock, Context, Cron, Effect, FiberMap, Layer } from "effect"

export interface Job {
  readonly id: string
  readonly cron: Cron.Cron
  readonly nextRunAt: Date
  readonly run: (dueAt: Date, nextAt: Date) => Effect.Effect<void>
}

export class Scheduler extends Context.Service<
  Scheduler,
  {
    readonly put: (job: Job) => Effect.Effect<void>
    readonly remove: (id: string) => Effect.Effect<void>
  }
>()("hinacode/Scheduler") {}

const LONGEST_NAP_MS = 60_000

const loop = ({ id, cron, nextRunAt, run }: Job) =>
  Effect.gen(function* () {
    let dueAt = nextRunAt
    while (true) {
      const now = yield* Clock.currentTimeMillis
      const wait = dueAt.getTime() - now
      if (wait > 0) {
        yield* Effect.sleep(Math.min(wait, LONGEST_NAP_MS))
        continue
      }
      const nextAt = Cron.next(cron, Math.max(now, dueAt.getTime()))
      yield* run(dueAt, nextAt).pipe(Effect.catchCause((cause) => Effect.logWarning("scheduled job failed", id, cause)))
      dueAt = nextAt
    }
  })

const make = Effect.gen(function* () {
  const jobs = yield* FiberMap.make<string>()
  return Scheduler.of({
    put: (job) => Effect.asVoid(FiberMap.run(jobs, job.id, loop(job))),
    remove: (id) => FiberMap.remove(jobs, id),
  })
})

export const layer = Layer.effect(Scheduler, make)
