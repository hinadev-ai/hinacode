import { Schema } from "effect"

export type {
  ApprovalChoice,
  ApprovalRequestParams,
  ApprovalResolvedParams,
  ApprovalUpdatedParams,
  Item,
  ItemCompletedParams,
  ItemDeltaParams,
  ItemStartedParams,
  ItemUpdatedParams,
  SessionCompactResult,
  SessionContextUsageParams,
  SessionResumeResult,
  SessionStartResult,
  TurnCompletedParams,
  TurnInputPart,
  TurnModelRetryScheduledParams,
  TurnStartResult,
  UserInputAnswer,
  UserInputQuestion,
  UserInputRequestParams,
  UserInputSettledParams,
} from "@muse-code/sdk/dist/src/msp.js"

/** `turn/modelRetryScheduled`, which Muse 1.4.13 sends and SDK 1.4.7 does not type: a model call failed and runs again. */
export interface TurnModelRetryScheduledParams {
  readonly httpStatus?: number
}

/** `account/read`, an experimental method: which credential the host signs model calls with. */
export const AccountState = Schema.Struct({
  /** `accountLogin` for a Meta login, `apiKey` or `envKey` for a key, `loggedOut`. Open for new lanes. */
  state: Schema.String,
  /** The account's email for a Meta login. */
  label: Schema.optional(Schema.String),
  /** False when the endpoint needs no credential at all. */
  credentialRequired: Schema.Boolean,
})
export type AccountState = typeof AccountState.Type

export const CatalogModel = Schema.Struct({
  modelId: Schema.String,
  displayLabel: Schema.String,
  /** Every reasoning effort the model accepts, lowest first. */
  variants: Schema.optional(Schema.Array(Schema.String)),
  defaultReasoningEffort: Schema.optional(Schema.String),
})
export type CatalogModel = typeof CatalogModel.Type

export const ModelList = Schema.Struct({ models: Schema.Array(CatalogModel) })

/** One `skill/list` row: a typed-invocable shortcut spelling of a skill. */
export const SkillCatalogEntry = Schema.Struct({
  /** The shortcut token without the leading slash, bare or plugin-qualified (`acme:deploy`). */
  selector: Schema.String,
  description: Schema.String,
  argumentHint: Schema.optional(Schema.String),
  /** Where the skill comes from: `user`, `project`, `bundled`, `plugin` or a later source. */
  source: Schema.optional(Schema.String),
})
export type SkillCatalogEntry = typeof SkillCatalogEntry.Type

export const SkillList = Schema.Struct({ skills: Schema.Array(SkillCatalogEntry) })

/** `usage/changed`: the plan's usage as the host last saw it, with the provider's percentages verbatim. */
export const SubscriptionUsage = Schema.Struct({
  observedAtMs: Schema.Number,
  window: Schema.Struct({ usedPercent: Schema.Number, resetsAtMs: Schema.Number, windowDurationMins: Schema.Number }),
  weekly: Schema.Struct({ usedPercent: Schema.Number, resetsAtMs: Schema.Number }),
})
export type SubscriptionUsage = typeof SubscriptionUsage.Type

/** `session/tokenUsage`: what one model completion spent. */
export const CompletionUsage = Schema.Struct({
  modelId: Schema.NullOr(Schema.String),
  /** Prompt tokens with cached input counted once, whichever cache convention the provider uses. */
  promptTokens: Schema.Number,
  usage: Schema.Struct({
    outputTokens: Schema.Number,
    cachedTokens: Schema.Number,
    cacheReadTokens: Schema.optional(Schema.Number),
    cacheWriteTokens: Schema.optional(Schema.Number),
  }),
})
export type CompletionUsage = typeof CompletionUsage.Type

export const ViewPage = Schema.Struct({
  events: Schema.Array(Schema.Struct({ method: Schema.String, params: Schema.Unknown })),
  nextCursor: Schema.NullOr(Schema.String),
})
export type ViewPage = typeof ViewPage.Type

/**
 * A `toolCall` from `item/updated` or `item/completed`, with the fields that say whether it runs in the background.
 * Muse 1.4.12 marks a call it backgrounded itself, because it outlived its `yield_time_ms`, only with
 * `backgroundStatus.state: "backgrounded"`, which the SDK does not type. `background: true` marks a call sent
 * to the background with `task/background`.
 */
export const ToolCallFrame = Schema.Struct({
  sessionId: Schema.String,
  item: Schema.Struct({
    itemId: Schema.String,
    kind: Schema.Literal("toolCall"),
    status: Schema.String,
    tool: Schema.optional(Schema.String),
    args: Schema.optional(Schema.String),
    background: Schema.optional(Schema.Boolean),
    backgroundStatus: Schema.optional(Schema.Struct({ state: Schema.String })),
  }),
})
export type ToolCall = (typeof ToolCallFrame.Type)["item"]
