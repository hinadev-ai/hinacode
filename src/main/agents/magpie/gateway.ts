import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Data, Effect, Option, Schema } from "effect"
import { CLAUDE_EFFORT_LEVELS, type ModelInfo } from "../../../shared/agent.ts"

const DEFAULT_PORT = 3425
const REQUEST_TIMEOUT_MS = 3000
export const MAGPIE_KEY = "magpie-hinacode"

const Settings = Schema.Struct({ port: Schema.optionalKey(Schema.Number) })
const Hello = Schema.Struct({ name: Schema.Literal("magpie"), version: Schema.optionalKey(Schema.String) })
const GatewayModel = Schema.Struct({
  id: Schema.String,
  display_name: Schema.optionalKey(Schema.String),
  reasoning_levels: Schema.optionalKey(Schema.Array(Schema.String)),
  service_tiers: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))),
})
export type GatewayModel = typeof GatewayModel.Type
const ModelList = Schema.Struct({ data: Schema.Array(GatewayModel) })

export interface GatewayTarget {
  readonly endpoint: string | null
  readonly key: string | null
}

export const LOCAL_GATEWAY: GatewayTarget = { endpoint: null, key: null }

export interface Connection {
  readonly origin: string
  readonly key: string
  readonly version: string | null
}

export class GatewayError extends Data.TaggedError("GatewayError")<{ readonly message: string }> {}

const settingsPath = (env: NodeJS.ProcessEnv) =>
  join(env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "magpie", "settings.json")

const localPort = (env: NodeJS.ProcessEnv) =>
  Effect.promise(async () => {
    const text = await readFile(settingsPath(env), "utf8").catch(() => null)
    if (text === null) return DEFAULT_PORT
    return Schema.decodeUnknownOption(Settings)(JSON.parse(text)).pipe(
      Option.flatMapNullishOr((settings) => settings.port),
      Option.getOrElse(() => DEFAULT_PORT),
    )
  }).pipe(Effect.orElseSucceed(() => DEFAULT_PORT))

export const endpointOrigin = (endpoint: string) => endpoint.trim().replace(/\/+$/, "").replace(/\/v1$/, "")

const getJson = (origin: string, key: string, path: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`${origin}${path}`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
      catch: () => new GatewayError({ message: `Nothing answered at ${origin}` }),
    })
    if (response.status === 401 || response.status === 403)
      return yield* new GatewayError({
        message: `${origin} refused the key. Use a gateway key from magpie's Gateway keys`,
      })
    if (!response.ok) return yield* new GatewayError({ message: `${origin} answered ${response.status}` })
    return yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () => new GatewayError({ message: `${origin} is not a magpie gateway` }),
    })
  })

export const connect = (target: GatewayTarget, env: NodeJS.ProcessEnv = process.env) =>
  Effect.gen(function* () {
    const origin =
      target.endpoint === null ? `http://127.0.0.1:${yield* localPort(env)}` : endpointOrigin(target.endpoint)
    const key = target.key ?? MAGPIE_KEY
    const hello = yield* getJson(origin, key, "/api/hello").pipe(
      Effect.flatMap((body) =>
        Schema.decodeUnknownEffect(Hello)(body).pipe(
          Effect.mapError(() => new GatewayError({ message: `${origin} is not a magpie gateway` })),
        ),
      ),
      Effect.mapError((error) =>
        target.endpoint === null
          ? new GatewayError({
              message: "magpie is not running. Start the magpie app or `magpie serve`, then try again",
            })
          : error,
      ),
    )
    return { origin, key, version: hello.version ?? null } satisfies Connection
  })

export const modelsOf = (connection: Connection) =>
  getJson(connection.origin, connection.key, "/v1/models").pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(ModelList)(body).pipe(
        Effect.mapError(
          () => new GatewayError({ message: `${connection.origin} sent a model list HinaCode cannot read` }),
        ),
      ),
    ),
    Effect.map((list) => list.data),
  )

export const probe = (target: GatewayTarget, env: NodeJS.ProcessEnv = process.env) =>
  Effect.gen(function* () {
    const connection = yield* connect(target, env)
    const models = yield* modelsOf(connection)
    return { version: connection.version, models: models.length }
  })

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

export const claudeGatewayEnv = (
  { origin, key }: Pick<Connection, "origin" | "key">,
  model: GatewayModel,
  fast: boolean,
): Record<string, string> => {
  const efforts = claudeEfforts(model)
  return {
    ...Object.fromEntries(CLAUDE_BYPASS_VARIABLES.map((variable) => [variable, ""])),
    ANTHROPIC_BASE_URL: origin,
    ANTHROPIC_AUTH_TOKEN: key,
    ...Object.fromEntries(CLAUDE_TIER_VARIABLES.map((variable) => [variable, model.id])),
    ...(efforts.length > 0 && {
      CLAUDE_CODE_MODEL_CAPABILITIES: `${model.id.toLowerCase()}=${capabilities(efforts).join(",")}`,
    }),
    ...(fast && hasFastMode(model) && { CLAUDE_CODE_EXTRA_BODY: JSON.stringify({ speed: "fast" }) }),
  }
}
