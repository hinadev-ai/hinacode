import { join } from "node:path"
import { Effect, FileSystem } from "effect"
import type { Changes } from "../../shared/domain.ts"
import { Git, PATCH_FLAGS, parseNameStatus, UNQUOTED_PATHS } from "./Git.ts"

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
    const diff = (args: ReadonlyArray<string>) =>
      git.run(cwd, [...UNQUOTED_PATHS, "diff", "--no-renames", ...PATCH_FLAGS, ...args, base, tree])
    const files = parseNameStatus(yield* diff(["--name-status", "-z"]))
    const patch = yield* diff([])
    return { files, patch } satisfies Changes
  })
