import { Schema } from "effect"

export const Response = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.Literal("response"),
  command: Schema.String,
  success: Schema.Boolean,
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
})
export type Response = typeof Response.Type

export const UiRequest = Schema.Struct({
  type: Schema.Literal("extension_ui_request"),
  id: Schema.String,
  method: Schema.String,
  title: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  placeholder: Schema.optional(Schema.String),
  prefill: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Schema.String)),
})
export type UiRequest = typeof UiRequest.Type

export const PiModel = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  provider: Schema.String,
  contextWindow: Schema.optional(Schema.Number),
  reasoning: Schema.optional(Schema.Boolean),
  thinkingLevelMap: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type PiModel = typeof PiModel.Type

export const State = Schema.Struct({
  sessionId: Schema.String,
  model: Schema.optional(Schema.NullOr(PiModel)),
})

export const Models = Schema.Struct({ models: Schema.Array(PiModel) })

export const Commands = Schema.Struct({
  commands: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.optional(Schema.String) })),
})

export const Usage = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  cost: Schema.optional(Schema.Struct({ total: Schema.Number })),
})
export type Usage = typeof Usage.Type

export const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  usage: Schema.optional(Usage),
  stopReason: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
})

const ToolCall = Schema.Struct({ id: Schema.String, name: Schema.String, arguments: Schema.optional(Schema.Unknown) })

export const MessageUpdate = Schema.Struct({
  type: Schema.Literal("message_update"),
  assistantMessageEvent: Schema.Struct({
    type: Schema.String,
    delta: Schema.optional(Schema.String),
    toolCall: Schema.optional(ToolCall),
  }),
})

export const MessageEnd = Schema.Struct({ type: Schema.Literal("message_end"), message: Schema.Unknown })

export const ToolExecutionStart = Schema.Struct({
  type: Schema.Literal("tool_execution_start"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  args: Schema.optional(Schema.Unknown),
})

export const ToolExecutionEnd = Schema.Struct({
  type: Schema.Literal("tool_execution_end"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  result: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        content: Schema.optional(Schema.Array(Schema.Unknown)),
        details: Schema.optional(Schema.Unknown),
      }),
    ),
  ),
  isError: Schema.optional(Schema.Boolean),
})

export const CompactionStart = Schema.Struct({ type: Schema.Literal("compaction_start") })

export const CompactionEnd = Schema.Struct({
  type: Schema.Literal("compaction_end"),
  reason: Schema.optional(Schema.String),
  result: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        tokensBefore: Schema.optional(Schema.Number),
        estimatedTokensAfter: Schema.optional(Schema.Number),
      }),
    ),
  ),
  aborted: Schema.optional(Schema.Boolean),
  errorMessage: Schema.optional(Schema.String),
})

export const AgentSettled = Schema.Struct({ type: Schema.Literal("agent_settled"), aborted: Schema.Boolean })

export const PiEvent = Schema.Union([
  MessageUpdate,
  MessageEnd,
  ToolExecutionStart,
  ToolExecutionEnd,
  CompactionStart,
  CompactionEnd,
  AgentSettled,
])
export type PiEvent = typeof PiEvent.Type
