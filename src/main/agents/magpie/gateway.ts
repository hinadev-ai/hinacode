import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { CLAUDE_EFFORT_LEVELS, type ModelInfo } from "../../../shared/agent.ts"

const DEFAULT_PORT = 3425
const REQUEST_TIMEOUT_MS = 1500
export const MAGPIE_KEY = "magpie-hinacode"

const Settings = Schema.Struct({ port: Schema.optionalKey(Schema.Number) })
const Hello = Schema.Struct({ name: Schema.Literal("magpie") })
const GatewayModel = Schema.Struct({
  id: Schema.String,
  display_name: Schema.optionalKey(Schema.String),
  reasoning_levels: Schema.optionalKey(Schema.Array(Schema.String)),
  service_tiers: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))),
})
export type GatewayModel = typeof GatewayModel.Type
const ModelList = Schema.Struct({ data: Schema.Array(GatewayModel) })

const settingsPath = (env: NodeJS.ProcessEnv) =>
  join(env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "magpie", "settings.json")

const gatewayPort = async (env: NodeJS.ProcessEnv) => {
  const text = await readFile(settingsPath(env), "utf8").catch(() => null)
  if (text === null) return DEFAULT_PORT
  return Schema.decodeUnknownSync(Settings)(JSON.parse(text)).port ?? DEFAULT_PORT
}

const getJson = async (url: string) => {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${MAGPIE_KEY}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`magpie answered ${response.status}`)
  return response.json()
}

export const findGateway = (env: NodeJS.ProcessEnv = process.env) =>
  Effect.tryPromise(async () => {
    const origin = `http://127.0.0.1:${await gatewayPort(env)}`
    Schema.decodeUnknownSync(Hello)(await getJson(`${origin}/api/hello`))
    return origin
  }).pipe(Effect.orElseSucceed(() => null))

export const modelsAt = (origin: string) =>
  Effect.tryPromise(async () => Schema.decodeUnknownSync(ModelList)(await getJson(`${origin}/v1/models`)).data).pipe(
    Effect.orElseSucceed((): ReadonlyArray<GatewayModel> => []),
  )

export const gatewayModels = (env: NodeJS.ProcessEnv = process.env) =>
  Effect.flatMap(findGateway(env), (origin) => (origin === null ? Effect.succeed([]) : modelsAt(origin)))

const CLAUDE_EFFORTS = new Set(CLAUDE_EFFORT_LEVELS)

const claudeEfforts = (model: GatewayModel) =>
  (model.reasoning_levels ?? []).filter((effort) => CLAUDE_EFFORTS.has(effort))

const FAST_TIER = "priority"

const hasFastMode = (model: GatewayModel) => (model.service_tiers ?? []).some((tier) => tier.id === FAST_TIER)

export const magpieModelInfo = (model: GatewayModel): ModelInfo => ({
  id: model.id,
  label: model.display_name ?? model.id,
  provider: "magpie",
  efforts: claudeEfforts(model),
  defaultEffort: null,
  fastMode: hasFastMode(model),
  autoMode: false,
})

const sourceOf = (model: ModelInfo) => model.id.split("/")[0]

export const magpieModelInfos = (models: ReadonlyArray<GatewayModel>): ReadonlyArray<ModelInfo> => {
  const infos = models.map(magpieModelInfo)
  const counts = new Map<string, number>()
  for (const { label } of infos) counts.set(label, (counts.get(label) ?? 0) + 1)
  return infos.map((info) =>
    (counts.get(info.label) ?? 0) > 1 ? { ...info, label: `${info.label} · ${sourceOf(info)}` } : info,
  )
}

const CLAUDE_TIER_VARIABLES = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
]

const CLAUDE_BYPASS_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
]

const capabilities = (efforts: ReadonlyArray<string>) => [
  "effort",
  ...(efforts.includes("xhigh") ? ["xhigh_effort"] : []),
  ...(efforts.includes("max") ? ["max_effort"] : []),
]

export const claudeGatewayEnv = (origin: string, model: GatewayModel, fast: boolean): Record<string, string> => {
  const efforts = claudeEfforts(model)
  return {
    ...Object.fromEntries(CLAUDE_BYPASS_VARIABLES.map((variable) => [variable, ""])),
    ANTHROPIC_BASE_URL: origin,
    ANTHROPIC_AUTH_TOKEN: MAGPIE_KEY,
    ...Object.fromEntries(CLAUDE_TIER_VARIABLES.map((variable) => [variable, model.id])),
    ...(efforts.length > 0 && {
      CLAUDE_CODE_MODEL_CAPABILITIES: `${model.id.toLowerCase()}=${capabilities(efforts).join(",")}`,
    }),
    ...(fast && hasFastMode(model) && { CLAUDE_CODE_EXTRA_BODY: JSON.stringify({ speed: "fast" }) }),
  }
}
