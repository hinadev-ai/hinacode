const MAGPIE_MODEL_PREFIX = "magpie/"

export const magpieModelId = (gatewayModel: string) => `${MAGPIE_MODEL_PREFIX}${gatewayModel}`

export const gatewayModelOf = (model: string) =>
  model.startsWith(MAGPIE_MODEL_PREFIX) ? model.slice(MAGPIE_MODEL_PREFIX.length) : null

export const magpieSourceOf = (model: string) => gatewayModelOf(model)?.split("/")[0] ?? null
