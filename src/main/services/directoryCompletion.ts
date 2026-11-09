import type { Dirent } from "node:fs"
import { access, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { isHomeRelative, looksLikeDirectoryPath, windowsDrive } from "../../shared/directoryPath.ts"
import type { DirectorySuggestion } from "../../shared/domain.ts"

const MAX_SUGGESTIONS = 50
const lastSeparator = (input: string) =>
  Math.max(
    input.lastIndexOf("/"),
    process.platform === "win32" || windowsDrive.test(input) || input.startsWith("~\\") ? input.lastIndexOf("\\") : -1,
  )

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

const isDirectory = async (parent: string, entry: Dirent) =>
  entry.isDirectory() ||
  (entry.isSymbolicLink() &&
    (await stat(join(parent, entry.name)).then(
      (target) => target.isDirectory(),
      () => false,
    )))

const suggest = async (input: string, home: string): Promise<ReadonlyArray<DirectorySuggestion>> => {
  if (!looksLikeDirectoryPath(input)) return []
  const typed = input === "~" ? "~/" : input
  const cut = lastSeparator(typed)
  const typedParent = typed.slice(0, cut + 1)
  const prefix = typed.slice(cut + 1).toLowerCase()
  const parent = isHomeRelative(typedParent) ? home + typedParent.slice(1) : typedParent
  const showHidden = prefix.startsWith(".")
  const entries = await readdir(parent, { withFileTypes: true })
  const candidates = entries.filter(
    (entry) => entry.name.toLowerCase().startsWith(prefix) && (showHidden || !entry.name.startsWith(".")),
  )
  const directories = (
    await Promise.all(candidates.map(async (entry) => ((await isDirectory(parent, entry)) ? entry.name : null)))
  )
    .filter((name) => name !== null)
    .toSorted((a, b) => a.localeCompare(b))
    .slice(0, MAX_SUGGESTIONS)
  return Promise.all(
    directories.map(async (name) => ({
      path: typedParent + name,
      name,
      repository: await exists(join(parent, name, ".git")),
    })),
  )
}

export const completeDirectory = (
  input: string,
  home: string = homedir(),
): Effect.Effect<ReadonlyArray<DirectorySuggestion>> =>
  Effect.promise(() => suggest(input, home).catch((): ReadonlyArray<DirectorySuggestion> => []))
