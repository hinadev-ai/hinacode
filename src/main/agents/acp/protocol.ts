import { Schema } from "effect"

export const PROTOCOL_VERSION = 1

export const METHOD_NOT_FOUND = -32601

export const AgentCapabilities = Schema.Struct({
  loadSession: Schema.optional(Schema.Boolean),
  promptCapabilities: Schema.optional(Schema.Struct({ image: Schema.optional(Schema.Boolean) })),
  sessionCapabilities: Schema.optional(Schema.Struct({ close: Schema.optional(Schema.Unknown) })),
})
export type AgentCapabilities = typeof AgentCapabilities.Type

export const InitializeResponse = Schema.Struct({
  protocolVersion: Schema.Number,
  agentCapabilities: Schema.optional(AgentCapabilities),
})

const SelectOption = Schema.Struct({
  value: Schema.String,
  name: Schema.String,
})

const SelectGroup = Schema.Struct({
  group: Schema.String,
  options: Schema.Array(SelectOption),
})

export const ConfigOption = Schema.Struct({
  id: Schema.String,
  category: Schema.optional(Schema.NullOr(Schema.String)),
  type: Schema.String,
  currentValue: Schema.optional(Schema.Unknown),
  options: Schema.optional(Schema.Array(Schema.Union([SelectOption, SelectGroup]))),
})
export type ConfigOption = typeof ConfigOption.Type

export const LegacyModels = Schema.Struct({
  currentModelId: Schema.String,
  availableModels: Schema.Array(Schema.Struct({ modelId: Schema.String, name: Schema.String })),
})
export type LegacyModels = typeof LegacyModels.Type

export const SessionSetup = Schema.Struct({
  configOptions: Schema.optional(Schema.NullOr(Schema.Array(ConfigOption))),
  models: Schema.optional(Schema.NullOr(LegacyModels)),
})
export type SessionSetup = typeof SessionSetup.Type

export const NewSessionResponse = Schema.Struct({
  sessionId: Schema.String,
  ...SessionSetup.fields,
})

export const PromptResponse = Schema.Struct({
  stopReason: Schema.String,
  usage: Schema.optional(Schema.NullOr(Schema.Struct({ inputTokens: Schema.Number, outputTokens: Schema.Number }))),
})
export type PromptResponse = typeof PromptResponse.Type

export const SessionNotification = Schema.Struct({
  sessionId: Schema.String,
  update: Schema.Unknown,
})

export const AvailableCommandsUpdate = Schema.Struct({
  sessionUpdate: Schema.Literal("available_commands_update"),
  availableCommands: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optional(Schema.NullOr(Schema.String)),
      input: Schema.optional(Schema.NullOr(Schema.Struct({ hint: Schema.optional(Schema.String) }))),
    }),
  ),
})

export const ConfigOptionUpdate = Schema.Struct({
  sessionUpdate: Schema.Literal("config_option_update"),
  configOptions: Schema.Array(ConfigOption),
})

export const ToolCallFields = Schema.Struct({
  toolCallId: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  kind: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  locations: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ path: Schema.String })))),
  content: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  rawInput: Schema.optional(Schema.Unknown),
  rawOutput: Schema.optional(Schema.Unknown),
})
export type ToolCallFields = typeof ToolCallFields.Type

export const PermissionOption = Schema.Struct({
  optionId: Schema.String,
  kind: Schema.String,
  name: Schema.optional(Schema.String),
})
export type PermissionOption = typeof PermissionOption.Type

export const RequestPermissionParams = Schema.Struct({
  sessionId: Schema.String,
  toolCall: ToolCallFields,
  options: Schema.Array(PermissionOption),
})
export type RequestPermissionParams = typeof RequestPermissionParams.Type
