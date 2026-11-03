import { monitorEventLoopDelay } from "node:perf_hooks"
import { Clock, Effect, Layer, Schedule } from "effect"
import type { SlowSpan, SpanLedger } from "./trace.ts"

export const STALL_MS = 100
const CHECK_INTERVAL = "1 second"
const BUDGET_WINDOW_MS = 60_000
const BUDGET_BURST = 5
const NAMED_SPANS = 3

export type DelayHistogram = Pick<ReturnType<typeof monitorEventLoopDelay>, "max" | "reset" | "enable" | "disable">

export interface Budget {
  readonly windowStart: number
  readonly reported: number
  readonly suppressed: number
}

export const rollBudget = (budget: Budget, now: number) =>
  now - budget.windowStart < BUDGET_WINDOW_MS
    ? { budget, suppressed: 0 }
    : { budget: { windowStart: now, reported: 0, suppressed: 0 }, suppressed: budget.suppressed }

export const spendBudget = (budget: Budget) =>
  budget.reported < BUDGET_BURST
    ? { budget: { ...budget, reported: budget.reported + 1 }, report: true }
    : { budget: { ...budget, suppressed: budget.suppressed + 1 }, report: false }

const describeSpan = (span: SlowSpan) =>
  `${span.name}${span.detail ? ` ${span.detail}` : ""} (${Math.round(span.ms)}ms)`

export const stallMessage = (stallMs: number, slow: ReadonlyArray<SlowSpan>) => {
  const named = slow
    .toSorted((a, b) => Math.abs(a.ms - stallMs) - Math.abs(b.ms - stallMs))
    .slice(0, NAMED_SPANS)
    .map(describeSpan)
  const stalled = `main event loop stalled for ${Math.round(stallMs)}ms`
  return named.length === 0 ? stalled : `${stalled}, spans open around it: ${named.join(", ")}`
}

export const watchdogLayer = (ledger: SpanLedger, delays: DelayHistogram = monitorEventLoopDelay()) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => delays.enable()),
        () => Effect.sync(() => delays.disable()),
      )
      let budget: Budget = { windowStart: yield* Clock.currentTimeMillis, reported: 0, suppressed: 0 }

      const check = Effect.gen(function* () {
        const stallMs = delays.max / 1e6
        delays.reset()
        const now = yield* Clock.currentTimeNanos
        const slow = ledger.drainSlow(now)
        const rolled = rollBudget(budget, Number(now / 1_000_000n))
        budget = rolled.budget
        if (rolled.suppressed > 0)
          yield* Effect.logWarning(`main event loop watchdog suppressed ${rolled.suppressed} stalls`)
        if (stallMs < STALL_MS) return
        const spent = spendBudget(budget)
        budget = spent.budget
        if (spent.report) yield* Effect.logWarning(stallMessage(stallMs, slow))
      })

      yield* Effect.schedule(check, Schedule.spaced(CHECK_INTERVAL)).pipe(Effect.forkScoped)
    }),
  )
