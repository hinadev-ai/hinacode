import { Option, Schema } from "effect"
import type { LimitWindow, LimitWindowKind, PlanLimits } from "../../../shared/limits.ts"

const Window = Schema.Struct({ utilization: Schema.NullOr(Schema.Number), resets_at: Schema.NullOr(Schema.String) })
type Window = typeof Window.Type
const OptionalWindow = Schema.optional(Schema.NullOr(Window))

const UsageResponse = Schema.Struct({
  rate_limits_available: Schema.Boolean,
  rate_limits: Schema.NullOr(
    Schema.Struct({
      five_hour: OptionalWindow,
      seven_day: OptionalWindow,
      seven_day_opus: OptionalWindow,
      seven_day_sonnet: OptionalWindow,
      model_scoped: Schema.optional(Schema.Array(Schema.Struct({ ...Window.fields, display_name: Schema.String }))),
    }),
  ),
})
const decodeUsageResponse = Schema.decodeUnknownOption(UsageResponse)

const toWindow = (window: LimitWindowKind, raw: Window | null | undefined): ReadonlyArray<LimitWindow> =>
  raw?.utilization == null ? [] : [{ window, usedPercent: raw.utilization, resetsAt: raw.resets_at }]

export const toPlanLimits = (raw: unknown, readAt: string): PlanLimits | null => {
  const decoded = decodeUsageResponse(raw)
  if (Option.isNone(decoded) || !decoded.value.rate_limits_available || decoded.value.rate_limits === null) return null
  const limits = decoded.value.rate_limits
  const models = limits.model_scoped?.flatMap((model) =>
    toWindow({ kind: "model", name: model.display_name }, model),
  ) ?? [
    ...toWindow({ kind: "model", name: "Opus" }, limits.seven_day_opus),
    ...toWindow({ kind: "model", name: "Sonnet" }, limits.seven_day_sonnet),
  ]
  return {
    windows: [
      ...toWindow({ kind: "session" }, limits.five_hour),
      ...toWindow({ kind: "weekly" }, limits.seven_day),
      ...models,
    ],
    readAt,
  }
}
