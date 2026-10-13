import { execFileSync } from "node:child_process"

/** A packaged Electron app may not inherit the shell PATH (mise, Homebrew), so fall back to a login shell. */
export const resolveBinary = (name: string): string => {
  const attempts: Array<[string, Array<string>]> = [
    ["which", [name]],
    [process.env.SHELL ?? "/bin/sh", ["-ilc", `command -v ${name}`]],
  ]
  for (const [command, args] of attempts) {
    try {
      const path = execFileSync(command, args, { encoding: "utf8", timeout: 5000 }).trim().split("\n").at(-1)
      if (path) return path
    } catch {}
  }
  return name
}

const resolved = new Map<string, string>()

/** `resolveBinary` once per name, since it can block on a login shell. */
export const resolveBinaryOnce = (name: string): string => {
  const known = resolved.get(name)
  if (known !== undefined) return known
  const path = resolveBinary(name)
  resolved.set(name, path)
  return path
}
