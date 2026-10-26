import type { AgentAccount, ModelInfo } from "../../../shared/agent.ts"
import type { AccountState, CatalogModel } from "./protocol.ts"

/** The live catalog labels a model with its id, `muse-wonder-full-1.0`; spell it as Meta does, "Muse Wonder Full 1.0". */
const modelLabel = ({ modelId, displayLabel }: CatalogModel) =>
  displayLabel !== modelId
    ? displayLabel
    : modelId
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ")

export const toModelInfo = (model: CatalogModel): ModelInfo => ({
  id: model.modelId,
  label: modelLabel(model),
  provider: "muse",
  efforts: model.variants ?? [],
  defaultEffort: model.defaultReasoningEffort ?? null,
  fastMode: false,
  // Auto-review has an AI reviewer decide the actions that would otherwise ask.
  autoMode: true,
})

/** Muse does not say which plan a Meta login is on, so `plan` stays empty. */
export const toAccount = ({ state, label, credentialRequired }: AccountState): AgentAccount => {
  switch (state) {
    case "accountLogin":
      return { type: "subscription", email: label ?? null, plan: null, organization: null }
    case "apiKey":
    case "envKey":
      return { type: "apiKey" }
    case "loggedOut":
      return credentialRequired ? { type: "signedOut" } : { type: "external", service: "Muse Code" }
    default:
      return { type: "external", service: state }
  }
}
