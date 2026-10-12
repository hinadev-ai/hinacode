import { type Dirent, watch as watchFs } from "node:fs"
import { readdir, realpath } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import type { ChangedFileStatus, FsEntry, FsEntryKind } from "../../shared/domain.ts"
import { isInside } from "../security.ts"
import { type PersistenceError, persistence } from "./errors.ts"
import { Events } from "./Events.ts"
import { Git } from "./Git.ts"
import { parseNameStatus } from "./Worktrees.ts"

const reasons = {
  unknownRoot: "is not a project root or worktree",
  outsideRoot: "is not a folder inside",
  unreadable: "cannot be read in",
} as const

/** The renderer asked for something outside the folders kkcode manages, or for a folder that is gone. */
export class FsAccessError extends Schema.TaggedError<FsAccessError>()("FsAccessError", {
  root: Schema.String,
  path: Schema.String,
  reason: Schema.Literals(["unknownRoot", "outsideRoot", "unreadable"]),
}) {
  override get message(): string {
    return this.reason === "unknownRoot"
      ? `${this.root} ${reasons.unknownRoot}`
      : `"${this.path}" ${reasons[this.reason]} ${this.root}`
  }
}

export class Files extends Context.Service<
  Files,
  {
    /**
     * One level of the folder `path` (relative, "" for the root) under `root`, folders first. `root` must be
     * a project root or a worktree that is not removed, and `path` must resolve inside it.
     */
    readonly list: (
      root: string,
      path: string,
    ) => Effect.Effect<ReadonlyArray<FsEntry>, FsAccessError | PersistenceError>
    /**
     * Replaces the folders under `root` that push `fs.changed`. Folders that no longer exist are skipped,
     * and an empty `paths` closes every watcher of the root.
     */
    readonly watch: (
      root: string,
      paths: ReadonlyArray<string>,
    ) => Effect.Effect<void, FsAccessError | PersistenceError>
  }
>()("kkcode/Files") {}

const WATCH_DEBOUNCE_MS = 100

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true })

const byKindThenName = (a: FsEntry, b: FsEntry) =>
  Number(b.kind === "dir") - Number(a.kind === "dir") || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1)

const kindOf = (dirent: Dirent): FsEntryKind => {
  if (dirent.isSymbolicLink()) return "symlink"
  return dirent.isDirectory() ? "dir" : "file"
}

const childPath = (parent: string, name: string) => (parent === "" ? name : `${parent}/${name}`)

/** A `git status --porcelain` XY code as one status. */
const porcelainStatus = (code: string): ChangedFileStatus => {
  if (code === "??") return "untracked"
  if (code.includes("U") || code === "DD" || code === "AA") return "conflict"
  if (code.startsWith("A")) return "added"
  if (code.includes("D")) return "deleted"
  return "modified"
}

/** A folder shows conflict if anything under it conflicts, the shared status if all agree, else modified. */
const summarize = (statuses: ReadonlyArray<ChangedFileStatus>): ChangedFileStatus | null => {
  const [first] = statuses
  if (first === undefined) return null
  if (statuses.includes("conflict")) return "conflict"
  return first !== "deleted" && statuses.every((status) => status === first) ? first : "modified"
}

/**
 * The statuses that apply to `path`: its own, those of everything under it, and that of an untracked
 * folder above it, which `git status` reports as a single `dir/` entry.
 */
const statusOf = (path: string, changed: ReadonlyMap<string, ChangedFileStatus>) => {
  const below = `${path}/`
  const statuses: Array<ChangedFileStatus> = []
  for (const [changedPath, status] of changed) {
    const untrackedAbove = changedPath.endsWith("/") && path.startsWith(changedPath)
    if (changedPath === path || changedPath.startsWith(below) || untrackedAbove) statuses.push(status)
  }
  return summarize(statuses)
}

/** The real path of the folder `path` names, refusing `..`, absolute paths and symlinks that lead out of `root`. */
const resolveDir = (root: string, path: string) =>
  Effect.gen(function* () {
    const segments = path === "" ? [] : path.split("/")
    if (isAbsolute(path) || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      return yield* new FsAccessError({ root, path, reason: "outsideRoot" })
    }
    const [realRoot, target] = yield* Effect.tryPromise({
      try: () => Promise.all([realpath(root), realpath(join(root, ...segments))]),
      catch: () => new FsAccessError({ root, path, reason: "unreadable" }),
    })
    if (!isInside(realRoot, target)) return yield* new FsAccessError({ root, path, reason: "outsideRoot" })
    return target
  })

const readEntries = (root: string, path: string, dir: string) =>
  Effect.tryPromise({
    try: () => readdir(dir, { withFileTypes: true }),
    catch: () => new FsAccessError({ root, path, reason: "unreadable" }),
  }).pipe(
    Effect.map((dirents) =>
      dirents
        .filter((dirent) => dirent.name !== ".git")
        .map((dirent) => ({ name: dirent.name, path: childPath(path, dirent.name), kind: kindOf(dirent) })),
    ),
  )

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const git = yield* Git
  const events = yield* Events

  const findRoot = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ baseRef: Schema.NullOr(Schema.String) }),
    execute: (root) => sql`
      SELECT NULL AS base_ref FROM project WHERE root_path = ${root}
      UNION ALL
      SELECT base_ref FROM worktree WHERE path = ${root} AND status != 'removed'
    `,
  })

  /** The base ref to diff a worktree against, or null for a project root. Fails for any other folder. */
  const knownRoot = (root: string) =>
    Effect.gen(function* () {
      const rows = yield* findRoot(root).pipe(Effect.mapError(persistence("files.root")))
      if (rows.length === 0) return yield* new FsAccessError({ root, path: "", reason: "unknownRoot" })
      return rows.find((row) => row.baseRef !== null)?.baseRef ?? null
    })

  /** Entries of `entries` that git ignores. One `check-ignore` for the folder and all of its entries. */
  const ignoredPaths = (root: string, path: string, entries: ReadonlyArray<{ readonly path: string }>) => {
    const asked = path === "" ? entries.map((entry) => entry.path) : [path, ...entries.map((entry) => entry.path)]
    if (asked.length === 0) return Effect.succeed(new Set<string>())
    return git.run(root, ["check-ignore", "--stdin", "-z"], { stdin: `${asked.join("\0")}\0`, okExitCodes: [1] }).pipe(
      Effect.map((output) => {
        const ignored = new Set(output.split("\0").filter(Boolean))
        return path !== "" && ignored.has(path) ? new Set(asked) : ignored
      }),
      // Outside a git repository nothing is ignored.
      Effect.orElseSucceed(() => new Set<string>()),
    )
  }

  /** What the agent committed on the worktree's branch, relative to `root`, so the tree agrees with the Changes list. */
  const committed = (root: string, pathspec: string, baseRef: string | null) =>
    baseRef === null
      ? Effect.succeed([])
      : git.run(root, ["merge-base", baseRef, "HEAD"]).pipe(
          Effect.flatMap((mergeBase) =>
            git.run(root, [
              "diff",
              "--name-status",
              "-z",
              "--no-renames",
              "--relative",
              mergeBase.trim(),
              "--",
              pathspec,
            ]),
          ),
          Effect.map(parseNameStatus),
          // A base ref that no longer exists leaves only the uncommitted changes to show.
          Effect.orElseSucceed(() => []),
        )

  /** Changed paths under `path`, relative to `root`. Untracked folders keep a trailing `/`. */
  const changedPaths = (root: string, path: string, baseRef: string | null) =>
    Effect.gen(function* () {
      const pathspec = path === "" ? "." : path
      const [prefix, porcelain, fromBase] = yield* Effect.all(
        [
          git.run(root, ["rev-parse", "--show-prefix"]),
          git.run(root, ["status", "--porcelain", "-z", "--no-renames", "--untracked-files=normal", "--", pathspec]),
          committed(root, pathspec, baseRef),
        ],
        { concurrency: "unbounded" },
      )
      const changed = new Map(fromBase.map((file) => [file.path, file.status]))
      // Porcelain paths are relative to the repository, not to `root` when the project is a subfolder of it.
      const repoPrefix = prefix.trim()
      for (const record of porcelain.split("\0")) {
        const repoPath = record.slice(3)
        if (record.length < 4 || !repoPath.startsWith(repoPrefix)) continue
        const status = porcelainStatus(record.slice(0, 2))
        const relativePath = repoPath.slice(repoPrefix.length)
        if (status === "conflict" || !changed.has(relativePath)) changed.set(relativePath, status)
      }
      return changed
    }).pipe(Effect.orElseSucceed(() => new Map<string, ChangedFileStatus>()))

  const list = (root: string, path: string) =>
    Effect.gen(function* () {
      const baseRef = yield* knownRoot(root)
      const entries = yield* readEntries(root, path, yield* resolveDir(root, path))
      const [ignored, changed] = yield* Effect.all(
        [ignoredPaths(root, path, entries), changedPaths(root, path, baseRef)],
        { concurrency: "unbounded" },
      )
      return entries
        .map((entry) => ({ ...entry, ignored: ignored.has(entry.path), gitStatus: statusOf(entry.path, changed) }))
        .toSorted(byKindThenName)
    })

  /** Root -> watched folder path -> close. */
  const watchers = new Map<string, Map<string, () => void>>()

  const watchDir = (root: string, path: string, dir: string) =>
    Effect.try(() => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const changed = () => {
        clearTimeout(timer)
        timer = setTimeout(() => Effect.runFork(events.publish({ type: "fs.changed", root, path })), WATCH_DEBOUNCE_MS)
      }
      const watcher = watchFs(dir, changed)
      // The folder went away. The renderer re-lists it, gets an error and drops it.
      watcher.on("error", changed)
      return () => {
        clearTimeout(timer)
        watcher.close()
      }
    }).pipe(Effect.option)

  const closeAll = (root: string) => {
    for (const close of watchers.get(root)?.values() ?? []) close()
    watchers.delete(root)
  }

  const watch = (root: string, paths: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      // Closing needs no check, so a thread view can let go of a worktree that was just removed.
      if (paths.length === 0) return closeAll(root)
      yield* knownRoot(root)
      const current = watchers.get(root) ?? new Map<string, () => void>()
      for (const [path, close] of current) {
        if (!paths.includes(path)) {
          close()
          current.delete(path)
        }
      }
      for (const path of new Set(paths)) {
        if (current.has(path)) continue
        const dir = yield* resolveDir(root, path).pipe(
          Effect.map((resolved): string | null => resolved),
          Effect.catchIf(
            (error) => error.reason === "unreadable",
            () => Effect.succeed(null),
          ),
        )
        if (dir === null) continue
        const close = yield* watchDir(root, path, dir)
        if (close._tag === "Some") current.set(path, close.value)
      }
      watchers.set(root, current)
    })

  yield* Effect.addFinalizer(() => Effect.sync(() => [...watchers.keys()].forEach(closeAll)))

  return Files.of({ list, watch })
})

export const layer = Layer.effect(Files, make)
