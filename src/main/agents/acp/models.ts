import type { ModelInfo, ProviderId } from "../../../shared/agent.ts"
import type { ConfigOption, SessionSetup } from "./protocol.ts"

type ModelSelector =
  | { readonly via: "config"; readonly configId: string; readonly current: string | null }
  | { readonly via: "legacy"; readonly current: string }

interface ModelChoice {
  readonly id: string
  readonly label: string
}

export const AGENT_DEFAULT_EFFORT = "default"

const selectConfig = (setup: SessionSetup, category: string) =>
  setup.configOptions?.find((option) => option.category === category && option.type === "select")

const modelConfig = (setup: SessionSetup) => selectConfig(setup, "model")

const optionValues = (config: ConfigOption) =>
  (config.options ?? []).flatMap((entry) => ("group" in entry ? entry.options : [entry])).map((choice) => choice.value)

interface EffortSelector {
  readonly configId: string
  readonly current: string | null
  readonly levels: ReadonlyArray<string>
}

export const effortSelector = (setup: SessionSetup): EffortSelector | null => {
  const config = selectConfig(setup, "thought_level")
  if (config === undefined) return null
  const current = typeof config.currentValue === "string" ? config.currentValue : null
  return { configId: config.id, current, levels: optionValues(config) }
}

export const effortLevels = (setup: SessionSetup) =>
  effortSelector(setup)?.levels.filter((level) => level !== AGENT_DEFAULT_EFFORT) ?? []

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

export const toModelInfos = (
  setup: SessionSetup,
  provider: ProviderId,
  efforts: ReadonlyMap<string, ReadonlyArray<string>> = new Map(),
): ReadonlyArray<ModelInfo> => {
  const { current, choices } = modelChoices(setup)
  const ordered = [
    ...choices.filter((choice) => choice.id === current),
    ...choices.filter((choice) => choice.id !== current),
  ]
  return ordered.map((choice) => ({
    id: choice.id,
    label: choice.label,
    provider,
    efforts: efforts.get(choice.id) ?? [],
    defaultEffort: null,
    fastMode: false,
    autoMode: false,
  }))
}
