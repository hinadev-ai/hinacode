import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Effect } from "effect"
import { type InstalledAgent, ProviderId } from "../../shared/agent.ts"
import { providerCli } from "../../shared/providers.ts"
import { AgentError } from "./provider.ts"

const execFileAsync = promisify(execFile)

export const findBinary = async (name: string): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync("which", [name], { encoding: "utf8", timeout: 5000 })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

const found = new Map<string, string>()

export const installedBinary = (provider: ProviderId, name: string) =>
  Effect.gen(function* () {
    const key = `${name}\0${process.env["PATH"] ?? ""}`
    const path = found.get(key) ?? (yield* Effect.promise(() => findBinary(name)))
    if (path === undefined) {
      const { name: label, installUrl } = providerCli[provider]
      return yield* new AgentError({
        provider,
        message: `${label} is not installed. Install it from ${installUrl}, then try again`,
      })
    }
    found.set(key, path)
    return path
  })

export const detectAgents: Effect.Effect<ReadonlyArray<InstalledAgent>> = Effect.forEach(
  ProviderId.literals,
  (provider) =>
    Effect.promise(() => findBinary(providerCli[provider].binary)).pipe(
      Effect.map((path) => ({ provider, installed: path !== undefined })),
    ),
  { concurrency: "unbounded" },
)
