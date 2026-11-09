import { homedir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Record } from "effect"
import which from "which"
import { type AgentBinaryStatus, ProviderId } from "../../shared/agent.ts"
import { providerInfo } from "../../shared/providers.ts"
import { AgentError } from "./provider.ts"

export const findBinary = async (name: string): Promise<string | undefined> =>
  (await which(name, { nothrow: true })) ?? undefined

export interface AgentBinarySource {
  readonly configured: Effect.Effect<Partial<Record<ProviderId, string | null>>>
  readonly simulated: ReadonlySet<ProviderId>
}

export const AgentBinaries = Context.Reference<AgentBinarySource>("hinacode/AgentBinaries", {
  defaultValue: () => ({ configured: Effect.succeed({}), simulated: new Set() }),
})

const binaryOwner = (provider: ProviderId) =>
  ProviderId.literals.find((candidate) => providerInfo[candidate].binary === providerInfo[provider].binary) ?? provider

const expandHome = (path: string) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path)

const commandFor = (provider: ProviderId, name: string) =>
  Effect.gen(function* () {
    if (name !== providerInfo[provider].binary) return name
    const configured = yield* (yield* AgentBinaries).configured
    return expandHome(configured[binaryOwner(provider)] ?? name)
  })

const found = new Map<string, string>()

export const installedBinary = (provider: ProviderId, name: string) =>
  Effect.gen(function* () {
    const command = yield* commandFor(provider, name)
    const key = `${command}\0${process.env["PATH"] ?? ""}`
    const path = found.get(key) ?? (yield* Effect.promise(() => findBinary(command)))
    if (path === undefined) {
      const { name: label, installUrl } = providerInfo[provider]
      return yield* new AgentError({
        provider,
        message:
          command === name
            ? `${label} is not installed. Install it from ${installUrl}, then try again`
            : `${label} was not found at ${command}. Fix its CLI path in Settings > Providers`,
      })
    }
    found.set(key, path)
    return path
  })

const binaryStatus = (provider: ProviderId, simulated: ReadonlySet<ProviderId>): Effect.Effect<AgentBinaryStatus> =>
  simulated.has(provider)
    ? Effect.succeed({ installed: true, path: null })
    : installedBinary(provider, providerInfo[provider].binary).pipe(
        Effect.match({
          onFailure: () => ({ installed: false, path: null }),
          onSuccess: (path) => ({ installed: true, path }),
        }),
      )

export const binaryStatuses = Effect.gen(function* () {
  const { simulated } = yield* AgentBinaries
  return yield* Effect.all(
    {
      claude: binaryStatus("claude", simulated),
      codex: binaryStatus("codex", simulated),
      muse: binaryStatus("muse", simulated),
      opencode: binaryStatus("opencode", simulated),
      magpie: binaryStatus("magpie", simulated),
    } satisfies Record<ProviderId, Effect.Effect<AgentBinaryStatus>>,
    { concurrency: "unbounded" },
  )
})

export const installedProviders = Effect.map(binaryStatuses, (statuses) =>
  Record.map(statuses, (status) => status.installed),
)
