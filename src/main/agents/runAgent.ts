import {
  isRunAgentTool,
  presetModels,
  ProviderId,
  toolArgument,
  unlistedModel,
  type ModelInfo,
} from "../../shared/agent.ts"
import type { Message, MessagePart } from "../../shared/domain.ts"
import { providerInfo } from "../../shared/providers.ts"

type ToolCall = Extract<MessagePart, { type: "tool_call" }>

export const spawningCallId = (messages: ReadonlyArray<Message>, prompt: string): string | undefined =>
  messages
    .flatMap((message) => message.parts)
    .findLast(
      (part): part is ToolCall =>
        part.type === "tool_call" &&
        part.status === "running" &&
        isRunAgentTool(part.name) &&
        toolArgument(part.input, "prompt") === prompt,
    )?.callId

export type SubagentModel =
  | { readonly kind: "chosen"; readonly model: string }
  | { readonly kind: "refused"; readonly message: string }

export const pickedSubagentModel = (input: {
  readonly agent: string
  readonly requested: string | undefined
  readonly threadModel: string | null
  readonly picked: ReadonlyArray<string>
}): SubagentModel => {
  const allowed = [...new Set([...(input.threadModel === null ? [] : [input.threadModel]), ...input.picked])]
  const model = input.requested ?? allowed[0]
  if (model !== undefined && allowed.includes(model)) return { kind: "chosen", model }
  if (input.picked.length === 0) {
    return {
      kind: "refused",
      message: `The user has not picked any ${input.agent} models for sub-agents. Ask them to pick some in Settings, Providers, ${input.agent}, Models in the picker.`,
    }
  }
  return {
    kind: "refused",
    message: `${model} is not among the ${input.agent} models the user picked. Use one of: ${allowed.join(", ")}.`,
  }
}

export type SubagentChoice =
  | { readonly kind: "models"; readonly provider: ProviderId; readonly models: ReadonlyArray<ModelInfo> }
  | { readonly kind: "unpicked"; readonly provider: ProviderId }

export const subagentChoices = (
  listed: Readonly<Record<ProviderId, ReadonlyArray<ModelInfo> | null>>,
  presets: Readonly<Record<ProviderId, ReadonlyArray<string>>>,
): ReadonlyArray<SubagentChoice> =>
  ProviderId.literals.flatMap((provider): ReadonlyArray<SubagentChoice> => {
    const models = listed[provider]
    const picked = presets[provider]
    if (providerInfo[provider].subagentModels === "listed") {
      return models === null || models.length === 0
        ? []
        : [{ kind: "models", provider, models: presetModels(models, picked, null) }]
    }
    if (picked.length === 0) return models === null ? [] : [{ kind: "unpicked", provider }]
    const pickedModels = picked.map((id) => models?.find((model) => model.id === id) ?? unlistedModel(id, provider))
    return [{ kind: "models", provider, models: pickedModels }]
  })
