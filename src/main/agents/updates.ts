import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Effect, Option, Schema } from "effect"
import { type AgentUpdate, UpdatableProviderId } from "../../shared/agent.ts"
import { installedBinary } from "./binary.ts"
import { AgentError } from "./provider.ts"

const execFileAsync = promisify(execFile)

const packages: Record<UpdatableProviderId, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
}

const NpmRelease = Schema.Struct({ version: Schema.String })

const UPDATE_TIMEOUT_MS = 10 * 60_000

export const parseVersion = (output: string) => output.match(/\d+\.\d+\.\d+/)?.[0]

export const isNewer = (latest: string, current: string) => {
  const ours = current.split(".").map(Number)
  for (const [index, part] of latest.split(".").map(Number).entries()) {
    const other = ours[index] ?? 0
    if (part !== other) return part > other
  }
  return false
}

const installedVersion = (provider: UpdatableProviderId) =>
  Effect.gen(function* () {
    const path = yield* installedBinary(provider, provider)
    const { stdout } = yield* Effect.tryPromise({
      try: () => execFileAsync(path, ["--version"], { encoding: "utf8", timeout: 10_000 }),
      catch: () => new AgentError({ provider, message: `Could not read the version of ${path}` }),
    })
    const version = parseVersion(stdout)
    if (version === undefined) return yield* new AgentError({ provider, message: `${path} printed no version` })
    return version
  })

const latestVersion = (provider: UpdatableProviderId) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`https://registry.npmjs.org/${packages[provider]}/latest`, {
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`npm answered ${response.status}`)
      return Schema.decodeUnknownSync(NpmRelease)(await response.json()).version
    },
    catch: (cause) => new AgentError({ provider, message: `Could not check the latest release: ${String(cause)}` }),
  })

const availableUpdate = (provider: UpdatableProviderId) =>
  Effect.gen(function* () {
    const [current, latest] = yield* Effect.all([installedVersion(provider), latestVersion(provider)], {
      concurrency: "unbounded",
    })
    return isNewer(latest, current) ? Option.some<AgentUpdate>({ provider, current, latest }) : Option.none()
  }).pipe(Effect.catch(() => Effect.succeedNone))

export const availableUpdates = Effect.map(
  Effect.forEach(UpdatableProviderId.literals, availableUpdate, { concurrency: "unbounded" }),
  (updates) => updates.flatMap((update) => Option.toArray(update)),
)

// FIXME: a CLI's installer may exit cleanly without updating, such as a lagging Homebrew cask
export const installUpdate = (provider: UpdatableProviderId) =>
  Effect.gen(function* () {
    const path = yield* installedBinary(provider, provider)
    yield* Effect.tryPromise({
      try: () => execFileAsync(path, ["update"], { encoding: "utf8", timeout: UPDATE_TIMEOUT_MS }),
      catch: (cause) =>
        new AgentError({
          provider,
          message: `\`${provider} update\` failed: ${(cause as { stderr?: string }).stderr?.trim() || String(cause)}`,
        }),
    })
    const [installed, latest] = yield* Effect.all([installedVersion(provider), latestVersion(provider)])
    if (isNewer(latest, installed)) {
      return yield* new AgentError({
        provider,
        message: `\`${provider} update\` finished, but ${installed} is still installed. Run it in a terminal to see why.`,
      })
    }
    return installed
  })
