import { join } from "node:path"
import { Effect, FileSystem } from "effect"
import type { Changes } from "../../shared/domain.ts"
import { Git, parseNameStatus } from "./Git.ts"

const indexPaths = new Map<string, string>()

const indexPathOf = (cwd: string) =>
  Effect.gen(function* () {
    const cached = indexPaths.get(cwd)
    if (cached !== undefined) return cached
    const git = yield* Git
    const path = (yield* git.run(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim()
    indexPaths.set(cwd, path)
    return path
  })

export const snapshotWorkingTree = (cwd: string) =>
  Effect.gen(function* () {
    const git = yield* Git
    const fs = yield* FileSystem.FileSystem
    const realIndex = yield* indexPathOf(cwd)
    const index = join(yield* fs.makeTempDirectoryScoped({ prefix: "hinacode-index-" }), "index")
    // FIXME: `git add -A` rehashes every file unless the index copy keeps the real index's stat cache
    if (yield* fs.exists(realIndex)) yield* fs.copyFile(realIndex, index)
    else indexPaths.delete(cwd)
    const env = { GIT_INDEX_FILE: index }
    yield* git.run(cwd, ["add", "-A"], { env })
    return (yield* git.run(cwd, ["write-tree"], { env })).trim()
  }).pipe(Effect.scoped)

export const diffWorkingTree = <E, R>(cwd: string, base: Effect.Effect<string, E, R>) =>
  Effect.gen(function* () {
    const git = yield* Git
    const [baseTree, tree] = yield* Effect.all([base, snapshotWorkingTree(cwd)], { concurrency: "unbounded" })
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
        baseTree,
        tree,
      ])
    const { files, patch } = yield* Effect.all(
      { files: diff(["--name-status", "-z"]).pipe(Effect.map(parseNameStatus)), patch: diff([]) },
      { concurrency: "unbounded" },
    )
    return { files, patch } satisfies Changes
  })
