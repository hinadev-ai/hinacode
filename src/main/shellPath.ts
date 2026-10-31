import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const START = "__HINACODE_PATH_START__"
const END = "__HINACODE_PATH_END__"

const loginShellPath = async (shell: string): Promise<string | undefined> => {
  try {
    const run = execFileAsync(shell, ["-ilc", `printf '%s' ${START}; printenv PATH; printf '%s' ${END}`], {
      encoding: "utf8",
      timeout: 5000,
    })
    // FIXME: an rc file that reads stdin holds startup until the timeout
    run.child.stdin?.end()
    const { stdout: output } = await run
    const start = output.indexOf(START)
    const end = output.indexOf(END, start)
    return start === -1 || end === -1 ? undefined : output.slice(start + START.length, end).trim() || undefined
  } catch {
    return undefined
  }
}

const readCache = (cacheFile: string) => {
  try {
    return readFileSync(cacheFile, "utf8").trim() || undefined
  } catch {
    return undefined
  }
}

export interface PathHydration {
  readonly ready: Promise<void>
  readonly refreshed: Promise<void>
}

// FIXME: an app opened from the Dock or Finder gets launchd's PATH, without Homebrew, mise or nvm
export const hydratePath = (env: NodeJS.ProcessEnv, cacheFile?: string): PathHydration => {
  if (process.platform === "win32") return { ready: Promise.resolve(), refreshed: Promise.resolve() }
  const inherited = (env.PATH ?? "").split(":")
  const apply = (shellPath: string) => {
    env.PATH = [...new Set([...shellPath.split(":"), ...inherited].filter(Boolean))].join(":")
  }
  const cached = cacheFile === undefined ? undefined : readCache(cacheFile)
  if (cached !== undefined) apply(cached)
  const refreshed = loginShellPath(env.SHELL || "/bin/zsh").then(async (shellPath) => {
    if (shellPath === undefined) return
    apply(shellPath)
    if (cacheFile !== undefined && shellPath !== cached) await writeFile(cacheFile, shellPath).catch(() => undefined)
  })
  return { ready: cached === undefined ? refreshed : Promise.resolve(), refreshed }
}
