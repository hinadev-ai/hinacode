import type { ModelInfo } from "../../../shared/agent.ts"
import type { PiModel } from "./protocol.ts"

const BASE_LEVELS = ["off", "minimal", "low", "medium", "high"]
const OPT_IN_LEVELS = ["xhigh", "max"]
const DEFAULT_EFFORT = "medium"

export const effortLevels = (model: PiModel): ReadonlyArray<string> => {
  if (model.reasoning !== true) return []
  const map = model.thinkingLevelMap ?? {}
  return [...BASE_LEVELS, ...OPT_IN_LEVELS.filter((level) => map[level] !== undefined)].filter(
    (level) => map[level] !== null,
  )
}

export const toModelInfo = (model: PiModel): ModelInfo => {
  const efforts = effortLevels(model)
  return {
    id: `${model.provider}/${model.id}`,
    label: `${model.provider}/${model.name ?? model.id}`,
    provider: "pi",
    efforts,
    defaultEffort: efforts.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : null,
    fastMode: false,
    autoMode: false,
  }
}

export const modelArgs = (model: string): ReadonlyArray<string> => {
  if (model === "") return []
  const slash = model.indexOf("/")
  return slash === -1 ? ["--model", model] : ["--provider", model.slice(0, slash), "--model", model.slice(slash + 1)]
}
