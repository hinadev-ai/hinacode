import type { ModelInfo, ProviderId } from "../../../shared/agent.ts"
import type { SessionSetup } from "./protocol.ts"

export type ModelSelector =
  | { readonly via: "config"; readonly configId: string; readonly current: string | null }
  | { readonly via: "legacy"; readonly current: string }

interface ModelChoice {
  readonly id: string
  readonly label: string
}

const modelConfig = (setup: SessionSetup) =>
  setup.configOptions?.find((option) => option.category === "model" && option.type === "select")

export const modelSelector = (setup: SessionSetup): ModelSelector | null => {
  const config = modelConfig(setup)
  if (config !== undefined) {
    const current = typeof config.currentValue === "string" ? config.currentValue : null
    return { via: "config", configId: config.id, current }
  }
  if (setup.models != null) return { via: "legacy", current: setup.models.currentModelId }
  return null
}

const modelChoices = (setup: SessionSetup): { current: string | null; choices: ReadonlyArray<ModelChoice> } => {
  const config = modelConfig(setup)
  if (config !== undefined) {
    const choices = (config.options ?? []).flatMap((entry) => ("group" in entry ? entry.options : [entry]))
    return {
      current: typeof config.currentValue === "string" ? config.currentValue : null,
      choices: choices.map((choice) => ({ id: choice.value, label: choice.name })),
    }
  }
  if (setup.models != null) {
    const { currentModelId, availableModels } = setup.models
    return {
      current: currentModelId,
      choices: availableModels.map((model) => ({ id: model.modelId, label: model.name })),
    }
  }
  return { current: null, choices: [] }
}

export const toModelInfos = (setup: SessionSetup, provider: ProviderId): ReadonlyArray<ModelInfo> => {
  const { current, choices } = modelChoices(setup)
  const ordered = [
    ...choices.filter((choice) => choice.id === current),
    ...choices.filter((choice) => choice.id !== current),
  ]
  return ordered.map((choice) => ({
    id: choice.id,
    label: choice.label,
    provider,
    efforts: [],
    defaultEffort: null,
    fastMode: false,
    autoMode: false,
  }))
}
