import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { promisify } from "node:util"
import { Effect, Option, Schema } from "effect"
import { type AgentUpdate, UpdatableProviderId } from "../../shared/agent.ts"
import { installedBinary } from "./binary.ts"
import { miseOwnership, runMise } from "./mise.ts"
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
      try: () => execFileAsync(path, ["--version"], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" }),
      catch: () => new AgentError({ provider, message: `Could not read the version of ${path}` }),
    })
    const version = parseVersion(stdout)
    if (version === undefined) return yield* new AgentError({ provider, message: `${path} printed no version` })
    return version
  })

const npmLatestVersion = (provider: UpdatableProviderId) =>
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

interface Updater {
  readonly label: string
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly latestVersion: Effect.Effect<string, AgentError>
}

const updaterFor = (provider: UpdatableProviderId) =>
  Effect.gen(function* () {
    const binary = yield* installedBinary(provider, provider)
    const mise = yield* miseOwnership(binary, provider)
    switch (mise.kind) {
      case "none":
        return Option.some<Updater>({
          label: `${provider} update`,
          file: binary,
          args: ["update"],
          latestVersion: npmLatestVersion(provider),
        })
      case "manual":
        return Option.none<Updater>()
      case "upgradable":
        return Option.some<Updater>({
          label: `mise upgrade ${provider}`,
          file: mise.mise,
          args: ["upgrade", provider],
          latestVersion: runMise(mise.mise, ["latest", provider]).pipe(
            Effect.map(parseVersion),
            Effect.flatMap(Effect.fromNullishOr),
            Effect.mapError(
              () => new AgentError({ provider, message: `\`mise latest ${provider}\` printed no version` }),
            ),
          ),
        })
    }
  })

const availableUpdate = (provider: UpdatableProviderId) =>
  Effect.gen(function* () {
    const updater = yield* updaterFor(provider)
    if (Option.isNone(updater)) return Option.none<AgentUpdate>()
    const [current, latest] = yield* Effect.all([installedVersion(provider), updater.value.latestVersion], {
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
    const updater = yield* updaterFor(provider)
    if (Option.isNone(updater)) {
      return yield* new AgentError({
        provider,
        message: `mise manages ${provider} at a pinned version. Update it with mise`,
      })
    }
    const { label, file, args, latestVersion } = updater.value
    yield* Effect.tryPromise({
      try: () =>
        execFileAsync(file, args, {
          cwd: homedir(),
          encoding: "utf8",
          timeout: UPDATE_TIMEOUT_MS,
          killSignal: "SIGKILL",
        }),
      catch: (cause) =>
        new AgentError({
          provider,
          message: `\`${label}\` failed: ${(cause as { stderr?: string }).stderr?.trim() || String(cause)}`,
        }),
    })
    const [installed, latest] = yield* Effect.all([installedVersion(provider), latestVersion])
    if (isNewer(latest, installed)) {
      return yield* new AgentError({
        provider,
        message: `\`${label}\` finished, but ${installed} is still installed. Run it in a terminal to see why.`,
      })
    }
    return installed
  })
