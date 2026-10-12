import { join } from "node:path"
import { Effect, FileSystem } from "effect"
import type { ChangedFileStatus, Changes } from "../../shared/domain.ts"
import { Git } from "./Git.ts"

const toChangedStatus = (letter: string): ChangedFileStatus => {
  if (letter === "A") return "added"
  if (letter === "D") return "deleted"
  return "modified"
}

/** Parses `git diff --name-status -z`: alternating status letter and path. */
const parseNameStatus = (output: string) => {
  const fields = output.split("\0").filter(Boolean)
  const files: Array<{ path: string; status: ChangedFileStatus }> = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    files.push({ path: fields[i + 1] ?? "", status: toChangedStatus(fields[i]?.charAt(0) ?? "") })
  }
  return files
}

/**
 * Writes the whole working tree, untracked but not ignored files included, as a git tree and returns
 * its sha. The real index is left alone: staging happens in a copy of it.
 */
export const snapshotWorkingTree = (cwd: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    const fs = yield* FileSystem.FileSystem
    const realIndex = (yield* git.run(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim()
    const index = join(yield* fs.makeTempDirectoryScoped({ prefix: "kkcode-index-" }), "index")
    // Starting from the real index keeps its stat cache, so `add -A` only rehashes files that changed.
    // A repo without commits may have no index yet.
    if (yield* fs.exists(realIndex)) yield* fs.copyFile(realIndex, index)
    const env = { GIT_INDEX_FILE: index }
    yield* git.run(cwd, ["add", "-A"], { env })
    return (yield* git.run(cwd, ["write-tree"], { env })).trim()
  }).pipe(Effect.scoped)

/** What the working tree changed since `base`, a commit or tree, new files included. */
export const diffWorkingTree = (cwd: string, base: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    const tree = yield* snapshotWorkingTree(cwd)
    // Pin the output format against user config (diff.mnemonicPrefix, color.ui, quoted non-ASCII paths)
    // so the renderer can find each file's section by its `a/… b/…` header.
    const diff = (args: ReadonlyArray<string>) =>
      git.run(cwd, [
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-renames",
        "--no-color",
        "--no-ext-diff",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        ...args,
        base,
        tree,
      ])
    const files = parseNameStatus(yield* diff(["--name-status", "-z"]))
    const patch = yield* diff([])
    return { files, patch } satisfies Changes
  })
