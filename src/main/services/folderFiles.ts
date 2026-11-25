import { readdir } from "node:fs/promises"
import { join } from "node:path"

const SKIPPED_FOLDERS = new Set([".git", "node_modules"])

export const folderFiles = async (root: string, limit: number) => {
  const files: Array<string> = []
  const folders = [""]
  for (let folder = folders.shift(); folder !== undefined && files.length < limit; folder = folders.shift()) {
    const entries = await readdir(join(root, folder), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = folder === "" ? entry.name : `${folder}/${entry.name}`
      if (entry.isFile()) files.push(path)
      else if (entry.isDirectory() && !SKIPPED_FOLDERS.has(entry.name)) folders.push(path)
    }
  }
  return files.slice(0, limit)
}
