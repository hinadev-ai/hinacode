import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Effect } from "effect"
import type { ProviderId } from "../../shared/agent.ts"
import { AgentError } from "./provider.ts"

const execFileAsync = promisify(execFile)

/** The CLI on PATH, which `hydratePath` fills from the login shell at startup. */
export const findBinary = async (name: string): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync("which", [name], { encoding: "utf8", timeout: 5000 })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

const install: Record<ProviderId, string> = {
  claude: "Claude Code is not installed. Install it from https://code.claude.com/docs/en/setup",
  codex: "Codex is not installed. Install it from https://learn.chatgpt.com/docs/codex/cli",
  muse: "Muse Code is not installed. Install it from https://dev.meta.ai/docs/muse-code",
}

const found = new Map<string, string>()

/**
 * The user's own agent CLI. kkcode ships none, because each one releases faster than kkcode does.
 * Only a hit is cached, so installing the CLI takes effect without restarting kkcode.
 */
export const installedBinary = (provider: ProviderId, name: string) =>
  Effect.gen(function* () {
    const path = found.get(name) ?? (yield* Effect.promise(() => findBinary(name)))
    if (path === undefined) {
      return yield* new AgentError({ provider, message: `${install[provider]}, then try again` })
    }
    found.set(name, path)
    return path
  })
