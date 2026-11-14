import { describe, expect, it } from "@effect/vitest"
import { Cron, Effect } from "effect"
import { TestClock } from "effect/testing"
import { layer, Scheduler } from "./Scheduler.ts"

const hourly = Cron.parseUnsafe("0 * * * *", "UTC")
const at = (iso: string) => new Date(iso)

const recorder = () => {
  const fired: Array<string> = []
  return { fired, run: (dueAt: Date) => Effect.sync(() => void fired.push(dueAt.toISOString())) }
}

const scheduled = <A, E>(test: Effect.Effect<A, E, Scheduler>) => test.pipe(Effect.provide(layer))

describe("Scheduler", () => {
  it.effect("fires a due job once and waits for its next slot", () =>
    scheduled(
      Effect.gen(function* () {
        yield* TestClock.setTime(at("2026-11-10T00:30:00.000Z").getTime())
        const { fired, run } = recorder()
        yield* Scheduler.use((scheduler) =>
          scheduler.put({ id: "job", cron: hourly, nextRunAt: at("2026-11-10T01:00:00.000Z"), run }),
        )
        yield* TestClock.adjust("29 minutes")
        expect(fired).toStrictEqual([])
        yield* TestClock.adjust("1 minute")
        expect(fired).toStrictEqual(["2026-11-10T01:00:00.000Z"])
        yield* TestClock.adjust("59 minutes")
        expect(fired).toStrictEqual(["2026-11-10T01:00:00.000Z"])
      }),
    ),
  )

  it.effect("fires a missed slot once, then skips the backlog to the next future slot", () =>
    scheduled(
      Effect.gen(function* () {
        yield* TestClock.setTime(at("2026-11-10T10:20:00.000Z").getTime())
        const { fired, run } = recorder()
        yield* Scheduler.use((scheduler) =>
          scheduler.put({ id: "job", cron: hourly, nextRunAt: at("2026-11-10T03:00:00.000Z"), run }),
        )
        yield* TestClock.adjust("1 second")
        expect(fired).toStrictEqual(["2026-11-10T03:00:00.000Z"])
        yield* TestClock.adjust("39 minutes")
        expect(fired).toStrictEqual(["2026-11-10T03:00:00.000Z"])
        yield* TestClock.adjust("1 minute")
        expect(fired).toStrictEqual(["2026-11-10T03:00:00.000Z", "2026-11-10T11:00:00.000Z"])
      }),
    ),
  )

  it.effect("hands each run the slot it will fire next", () =>
    scheduled(
      Effect.gen(function* () {
        yield* TestClock.setTime(at("2026-11-10T00:59:59.999Z").getTime())
        const slots: Array<[string, string]> = []
        yield* Scheduler.use((scheduler) =>
          scheduler.put({
            id: "job",
            cron: Cron.parseUnsafe("* * * * *", "UTC"),
            nextRunAt: at("2026-11-10T00:59:00.000Z"),
            run: (dueAt, nextAt) => Effect.sync(() => void slots.push([dueAt.toISOString(), nextAt.toISOString()])),
          }),
        )
        yield* TestClock.adjust("2 minutes")
        expect(slots).toStrictEqual([
          ["2026-11-10T00:59:00.000Z", "2026-11-10T01:00:00.000Z"],
          ["2026-11-10T01:00:00.000Z", "2026-11-10T01:01:00.000Z"],
          ["2026-11-10T01:01:00.000Z", "2026-11-10T01:02:00.000Z"],
        ])
      }),
    ),
  )

  it.effect("keeps running after a job fails", () =>
    scheduled(
      Effect.gen(function* () {
        yield* TestClock.setTime(at("2026-11-10T00:59:00.000Z").getTime())
        const fired: Array<string> = []
        yield* Scheduler.use((scheduler) =>
          scheduler.put({
            id: "job",
            cron: hourly,
            nextRunAt: at("2026-11-10T01:00:00.000Z"),
            run: (dueAt) =>
              Effect.sync(() => void fired.push(dueAt.toISOString())).pipe(Effect.andThen(Effect.die("boom"))),
          }),
        )
        yield* TestClock.adjust("2 hours")
        expect(fired).toStrictEqual(["2026-11-10T01:00:00.000Z", "2026-11-10T02:00:00.000Z"])
      }),
    ),
  )

  it.effect("stops a removed job", () =>
    scheduled(
      Effect.gen(function* () {
        yield* TestClock.setTime(at("2026-11-10T00:30:00.000Z").getTime())
        const { fired, run } = recorder()
        const scheduler = yield* Scheduler
        yield* scheduler.put({ id: "job", cron: hourly, nextRunAt: at("2026-11-10T01:00:00.000Z"), run })
        yield* scheduler.remove("job")
        yield* TestClock.adjust("3 hours")
        expect(fired).toStrictEqual([])
      }),
    ),
  )
})
