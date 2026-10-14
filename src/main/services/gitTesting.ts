import { execFileSync } from "node:child_process"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const useHostileDiffConfig = (root: string) => {
  const external = join(root, ".git", "external-diff")
  writeFileSync(external, "#!/bin/sh\necho EXTERNAL DIFF\n")
  chmodSync(external, 0o755)
  const config = {
    "color.ui": "always",
    "color.diff": "always",
    "diff.mnemonicPrefix": "true",
    "diff.noprefix": "true",
    "diff.external": external,
    "diff.renames": "copies",
    "core.quotePath": "true",
  }
  for (const [key, value] of Object.entries(config)) execFileSync("git", ["-C", root, "config", key, value])
}
