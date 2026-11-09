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

const UNPICKED_MODEL_LIMIT = 20
const SUGGESTION_LIMIT = 20

const wordsOf = (id: string) =>
  id
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((word) => word.length >= 3)

const similarModels = (requested: string, listed: ReadonlyArray<string>) => {
  const words = wordsOf(requested)
  return listed.filter((id) => words.some((word) => id.toLowerCase().includes(word))).slice(0, SUGGESTION_LIMIT)
}

export const pickedSubagentModel = (input: {
  readonly agent: string
  readonly requested: string | undefined
  readonly threadModel: string | null
  readonly picked: ReadonlyArray<string>
  readonly listed: ReadonlyArray<string>
}): SubagentModel => {
  const unpicked = input.picked.length === 0
  const offered = unpicked ? input.listed.slice(0, UNPICKED_MODEL_LIMIT) : input.picked
  const allowed = [...new Set([...(input.threadModel === null ? [] : [input.threadModel]), ...offered])]
  const model = input.requested ?? allowed[0]
  if (model === undefined) return { kind: "refused", message: `${input.agent} lists no models.` }
  if (allowed.includes(model) || (unpicked && input.listed.includes(model))) return { kind: "chosen", model }
  if (!unpicked) {
    return {
      kind: "refused",
      message: `${model} is not among the ${input.agent} models the user picked. Use one of: ${allowed.join(", ")}.`,
    }
  }
  const similar = similarModels(model, input.listed)
  return {
    kind: "refused",
    message: `${input.agent} does not list ${model}. ${similar.length > 0 ? "Similar ids" : "Some ids it lists"}: ${(similar.length > 0 ? similar : allowed).join(", ")}.`,
  }
}

export interface SubagentChoice {
  readonly provider: ProviderId
  readonly models: ReadonlyArray<ModelInfo>
  readonly hidden: number
}

export const pickedSubagentModels = (
  provider: ProviderId,
  listed: ReadonlyArray<ModelInfo> | null,
  picked: ReadonlyArray<string>,
): ReadonlyArray<ModelInfo> =>
  picked.length === 0
    ? (listed ?? []).slice(0, UNPICKED_MODEL_LIMIT)
    : picked.map((id) => listed?.find((model) => model.id === id) ?? unlistedModel(id, provider))

export const subagentChoices = (
  listed: Readonly<Record<ProviderId, ReadonlyArray<ModelInfo> | null>>,
  presets: Readonly<Record<ProviderId, ReadonlyArray<string>>>,
  enabled: ReadonlyArray<ProviderId>,
): ReadonlyArray<SubagentChoice> =>
  enabled.flatMap((provider): ReadonlyArray<SubagentChoice> => {
    const models = listed[provider]
    const picked = presets[provider]
    const chosen =
      providerInfo[provider].subagentModels === "listed"
        ? presetModels(models ?? [], picked, null)
        : pickedSubagentModels(provider, models, picked)
    const hidden =
      providerInfo[provider].subagentModels === "picked" && picked.length === 0
        ? (models?.length ?? 0) - chosen.length
        : 0
    return chosen.length === 0 ? [] : [{ provider, models: chosen, hidden }]
  })
