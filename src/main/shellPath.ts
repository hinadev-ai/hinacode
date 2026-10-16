import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const START = "__HINACODE_PATH_START__"
const END = "__HINACODE_PATH_END__"

/** PATH as the user's login shell sets it. The markers fence it off from whatever the rc files print. */
const loginShellPath = async (shell: string): Promise<string | undefined> => {
  try {
    const run = execFileAsync(shell, ["-ilc", `printf '%s' ${START}; printenv PATH; printf '%s' ${END}`], {
      encoding: "utf8",
      timeout: 5000,
    })
    // An rc file that reads stdin would otherwise hold startup until the timeout.
    run.child.stdin?.end()
    const { stdout: output } = await run
    const start = output.indexOf(START)
    const end = output.indexOf(END, start)
    return start === -1 || end === -1 ? undefined : output.slice(start + START.length, end).trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * An app started from the Dock or Finder gets launchd's PATH, `/usr/bin:/bin:/usr/sbin:/sbin`, without Homebrew,
 * mise or nvm. Puts the login shell's PATH in front, so `gh`, git's credential helper, `rg` and the agent CLIs
 * resolve as they do in a terminal. Await it before anything spawns.
 */
export const hydratePath = async (env: NodeJS.ProcessEnv) => {
  if (process.platform === "win32") return
  const shellPath = await loginShellPath(env.SHELL || "/bin/zsh")
  if (shellPath === undefined) return
  const entries = [...shellPath.split(":"), ...(env.PATH ?? "").split(":")].filter(Boolean)
  env.PATH = [...new Set(entries)].join(":")
}
