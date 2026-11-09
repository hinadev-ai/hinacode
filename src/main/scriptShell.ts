import { access } from "node:fs/promises"
import { dirname, join } from "node:path"
import { findBinary } from "./agents/binary.ts"

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

const gitBash = async () => {
  const git = await findBinary("git")
  if (git === undefined) return undefined
  const besideGit = [join(dirname(git), "..", "bin", "bash.exe"), join(dirname(git), "..", "..", "bin", "bash.exe")]
  for (const bash of besideGit) if (await exists(bash)) return bash
  return undefined
}

export const scriptShell = async (): Promise<string | undefined> =>
  process.platform === "win32" ? gitBash() : process.env["SHELL"] || "/bin/sh"
