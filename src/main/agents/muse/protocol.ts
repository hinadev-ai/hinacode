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

export const SessionLeaveAck = Schema.Struct({ commandId: Schema.String })
export const SessionLeaveCompleted = Schema.Struct({
  commandId: Schema.String,
  outcome: Schema.String,
  reason: Schema.optional(Schema.String),
})

export const AccountState = Schema.Struct({
  state: Schema.String,
  label: Schema.optional(Schema.String),
  credentialRequired: Schema.Boolean,
})
export type AccountState = typeof AccountState.Type

export const CatalogModel = Schema.Struct({
  modelId: Schema.String,
  displayLabel: Schema.String,
  variants: Schema.optional(Schema.Array(Schema.String)),
  defaultReasoningEffort: Schema.optional(Schema.String),
})
export type CatalogModel = typeof CatalogModel.Type

export const ModelList = Schema.Struct({ models: Schema.Array(CatalogModel) })

export const SkillCatalogEntry = Schema.Struct({
  selector: Schema.String,
  description: Schema.String,
  argumentHint: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
})
export type SkillCatalogEntry = typeof SkillCatalogEntry.Type

export const SkillList = Schema.Struct({ skills: Schema.Array(SkillCatalogEntry) })

export const SubscriptionUsage = Schema.Struct({
  observedAtMs: Schema.Number,
  window: Schema.Struct({ usedPercent: Schema.Number, resetsAtMs: Schema.Number, windowDurationMins: Schema.Number }),
  weekly: Schema.Struct({ usedPercent: Schema.Number, resetsAtMs: Schema.Number }),
})
export type SubscriptionUsage = typeof SubscriptionUsage.Type

export const CompletionUsage = Schema.Struct({
  modelId: Schema.NullOr(Schema.String),
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

// FIXME: Muse marks a call it backgrounded itself only with the untyped `backgroundStatus.state`
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
