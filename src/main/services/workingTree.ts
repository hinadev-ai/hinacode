import { join } from "node:path"
import { Deferred, Effect, type Exit, FileSystem, type PlatformError } from "effect"
import type { Changes } from "../../shared/domain.ts"
import { type CommandError, Git, parseRawWithPatch, RAW_WITH_PATCH_ARGS } from "./Git.ts"

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

type SnapshotError = CommandError | PlatformError.PlatformError

const snapshotsInFlight = new Map<string, Deferred.Deferred<string, SnapshotError>>()

const joinSnapshotInFlight = (cwd: string) =>
  Effect.gen(function* () {
    const running = snapshotsInFlight.get(cwd)
    if (running !== undefined) return yield* Deferred.await(running)
    const snapshot = Deferred.makeUnsafe<string, SnapshotError>()
    snapshotsInFlight.set(cwd, snapshot)
    const settle = (exit: Exit.Exit<string, SnapshotError>) => {
      snapshotsInFlight.delete(cwd)
      return Deferred.done(snapshot, exit)
    }
    yield* snapshotWorkingTree(cwd).pipe(Effect.exit, Effect.flatMap(settle), Effect.forkDetach)
    return yield* Deferred.await(snapshot)
  })

export const diffWorkingTree = <E, R>(cwd: string, base: Effect.Effect<string, E, R>) =>
  Effect.gen(function* () {
    const git = yield* Git
    const [baseTree, tree] = yield* Effect.all([base, joinSnapshotInFlight(cwd)], { concurrency: "unbounded" })
    const output = yield* git.run(cwd, [
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-renames",
      "--no-color",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      ...RAW_WITH_PATCH_ARGS,
      baseTree,
      tree,
    ])
    return parseRawWithPatch(output) satisfies Changes
  })
