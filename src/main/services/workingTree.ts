import { join } from "node:path"
import { Effect, FileSystem } from "effect"
import type { Changes } from "../../shared/domain.ts"
import { Git, parseNameStatus } from "./Git.ts"

export const snapshotWorkingTree = (cwd: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    const fs = yield* FileSystem.FileSystem
    const realIndex = (yield* git.run(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim()
    const index = join(yield* fs.makeTempDirectoryScoped({ prefix: "hinacode-index-" }), "index")
    // FIXME: `git add -A` rehashes every file unless the index copy keeps the real index's stat cache
    if (yield* fs.exists(realIndex)) yield* fs.copyFile(realIndex, index)
    const env = { GIT_INDEX_FILE: index }
    yield* git.run(cwd, ["add", "-A"], { env })
    return (yield* git.run(cwd, ["write-tree"], { env })).trim()
  }).pipe(Effect.scoped)

export const diffWorkingTree = (cwd: string, base: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    const tree = yield* snapshotWorkingTree(cwd)
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
