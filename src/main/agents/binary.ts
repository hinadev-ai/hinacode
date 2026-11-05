import { Effect } from "effect"
import which from "which"
import type { ProviderId } from "../../shared/agent.ts"
import { providerInfo } from "../../shared/providers.ts"
import { AgentError } from "./provider.ts"

export const findBinary = async (name: string): Promise<string | undefined> =>
  (await which(name, { nothrow: true })) ?? undefined

const found = new Map<string, string>()

export const installedBinary = (provider: ProviderId, name: string) =>
  Effect.gen(function* () {
    const key = `${name}\0${process.env["PATH"] ?? ""}`
    const path = found.get(key) ?? (yield* Effect.promise(() => findBinary(name)))
    if (path === undefined) {
      const { name: label, installUrl } = providerInfo[provider]
      return yield* new AgentError({
        provider,
        message: `${label} is not installed. Install it from ${installUrl}, then try again`,
      })
    }
    found.set(key, path)
    return path
  })
