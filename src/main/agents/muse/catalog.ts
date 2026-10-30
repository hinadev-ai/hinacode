import type { AgentAccount, ModelInfo } from "../../../shared/agent.ts"
import type { AccountState, CatalogModel } from "./protocol.ts"

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
  autoMode: true,
})

// FIXME: Muse does not report which plan a Meta login is on
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
