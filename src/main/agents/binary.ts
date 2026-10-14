import { execFileSync } from "node:child_process"

interface LookupOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly mode?: "login" | "interactive"
}

/** GUI apps may lack the shell's PATH; a login shell can also print profile output around the lookup. */
export const lookupExecutable = (
  name: string,
  { env = process.env, mode = "interactive" }: LookupOptions = {},
): string | undefined => {
  const attempts: Array<[string, Array<string>]> = [
    ["which", [name]],
    [env.SHELL ?? "/bin/sh", [mode === "interactive" ? "-ilc" : "-lc", `command -v ${name}`]],
  ]
  for (const [command, args] of attempts) {
    try {
      const output = execFileSync(command, args, {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      })
      const path = output.split("\n").findLast((line) => line.startsWith("/"))
      if (path !== undefined) return path.trim()
    } catch {}
  }
  return undefined
}

const found = new Map<string, string | undefined>()

export const cachedExecutable = (
  name: string,
  { mode = "interactive" }: Pick<LookupOptions, "mode"> = {},
): string | undefined => {
  const key = JSON.stringify([name, mode])
  if (!found.has(key)) found.set(key, lookupExecutable(name, { mode }))
  return found.get(key)
}
