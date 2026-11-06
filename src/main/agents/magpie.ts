import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import type { ModelInfo, ProviderId } from "../../shared/agent.ts"
import { magpieModelId } from "../../shared/magpie.ts"

const DEFAULT_PORT = 3425
const REQUEST_TIMEOUT_MS = 1500
export const MAGPIE_KEY = "magpie-hinacode"

const Settings = Schema.Struct({ port: Schema.optionalKey(Schema.Number) })
const Hello = Schema.Struct({ name: Schema.Literal("magpie") })
const GatewayModel = Schema.Struct({
  id: Schema.String,
  display_name: Schema.optionalKey(Schema.String),
  reasoning_levels: Schema.optionalKey(Schema.Array(Schema.String)),
})
type GatewayModel = typeof GatewayModel.Type
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

export const gatewayModels = (env: NodeJS.ProcessEnv = process.env) =>
  Effect.flatMap(findGateway(env), (origin) =>
    origin === null
      ? Effect.succeed([])
      : Effect.tryPromise(
          async () => Schema.decodeUnknownSync(ModelList)(await getJson(`${origin}/v1/models`)).data,
        ).pipe(Effect.orElseSucceed((): ReadonlyArray<GatewayModel> => [])),
  )

export const magpieModelInfo = (
  model: GatewayModel,
  provider: ProviderId,
  agentEfforts: ReadonlyArray<string>,
): ModelInfo => ({
  id: magpieModelId(model.id),
  label: model.display_name ?? model.id,
  provider,
  efforts: (model.reasoning_levels ?? []).filter((effort) => agentEfforts.includes(effort)),
  defaultEffort: null,
  fastMode: false,
  autoMode: false,
})

const CLAUDE_TIER_VARIABLES = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
]

export const claudeGatewayEnv = (origin: string, gatewayModel: string): Record<string, string> => ({
  ANTHROPIC_BASE_URL: origin,
  ANTHROPIC_AUTH_TOKEN: MAGPIE_KEY,
  ...Object.fromEntries(CLAUDE_TIER_VARIABLES.map((variable) => [variable, gatewayModel])),
})
