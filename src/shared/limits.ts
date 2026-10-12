import { Schema } from "effect"

export const UsageLimit = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("usage"),
    message: Schema.String,
    reset: Schema.NullOr(Schema.Struct({ at: Schema.String, autoResume: Schema.Boolean })),
  }),
  Schema.Struct({ kind: Schema.Literal("org_spend"), message: Schema.String }),
])
export type UsageLimit = typeof UsageLimit.Type
