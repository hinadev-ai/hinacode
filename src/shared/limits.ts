import { Effect, Schema } from "effect"

const LimitReset = Schema.NullOr(Schema.Struct({ at: Schema.String, autoResume: Schema.Boolean }))

/** An org spend limit carries the session reset too: an admin may raise the limit before then. */
export const UsageLimit = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("usage"), message: Schema.String, reset: LimitReset }),
  Schema.Struct({
    kind: Schema.Literal("org_spend"),
    message: Schema.String,
    reset: LimitReset.pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  }),
])
export type UsageLimit = typeof UsageLimit.Type

/** A plan allowance window. `model` is a per-model weekly bucket; `minutes` is any other length Codex reports. */
export const LimitWindowKind = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("session") }),
  Schema.Struct({ kind: Schema.Literal("weekly") }),
  Schema.Struct({ kind: Schema.Literal("model"), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("minutes"), minutes: Schema.Number }),
])
export type LimitWindowKind = typeof LimitWindowKind.Type

export const LimitWindow = Schema.Struct({
  window: LimitWindowKind,
  /** 0 to 100. */
  usedPercent: Schema.Number,
  resetsAt: Schema.NullOr(Schema.String),
})
export type LimitWindow = typeof LimitWindow.Type

export const PlanLimits = Schema.Struct({ windows: Schema.Array(LimitWindow), readAt: Schema.String })
export type PlanLimits = typeof PlanLimits.Type
