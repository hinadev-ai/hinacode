import { type Dirent, watch as watchFs } from "node:fs"
import { open, readdir, readFile, realpath, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import type { ChangedFileStatus, FsEntry, FsEntryKind, FsFileContent } from "../../shared/domain.ts"
import { isInside } from "../security.ts"
import { type PersistenceError, persistence } from "./errors.ts"
import { Events } from "./Events.ts"
import { Git, parseNameStatus } from "./Git.ts"

const reasons = {
  unknownRoot: "is not a project root or worktree",
  outsideRoot: "is not inside",
  unreadable: "cannot be read in",
  unwritable: "cannot be written in",
} as const

/** The renderer asked for something outside the folders kkcode manages, or for something that is gone. */
export class FsAccessError extends Schema.TaggedError<FsAccessError>()("FsAccessError", {
  root: Schema.String,
  path: Schema.String,
  reason: Schema.Literals(["unknownRoot", "outsideRoot", "unreadable", "unwritable"]),
}) {
  override get message(): string {
    return this.reason === "unknownRoot"
      ? `${this.root} ${reasons.unknownRoot}`
      : `"${this.path}" ${reasons[this.reason]} ${this.root}`
  }
}

/** The file no longer holds the text an edit started from, so saving would drop someone else's change. */
export class FsWriteConflict extends Schema.TaggedError<FsWriteConflict>()("FsWriteConflict", {
  root: Schema.String,
  path: Schema.String,
}) {
  override get message(): string {
    return `"${this.path}" changed on disk`
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
    /** Up to the first `MAX_READ_BYTES` of the file `path` under `root`, checked like `list`. */
    readonly read: (root: string, path: string) => Effect.Effect<FsFileContent, FsAccessError | PersistenceError>
    /**
     * Replaces the text of the existing file `path` under `root`, checked like `read`. Fails with
     * `FsWriteConflict` when `expected` is not null and the file no longer holds it.
     */
    readonly write: (
      root: string,
      path: string,
      content: string,
      expected: string | null,
    ) => Effect.Effect<void, FsAccessError | FsWriteConflict | PersistenceError>
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

export const MAX_READ_BYTES = 1024 * 1024

/** Git's own test: a NUL byte in the first 8000 bytes makes a file binary. */
const BINARY_SNIFF_BYTES = 8000

/** Reads one byte past the cap, which tells a file of exactly the cap from a longer one. */
const readStart = async (file: string): Promise<FsFileContent> => {
  const handle = await open(file, "r")
  try {
    const buffer = Buffer.alloc(MAX_READ_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const bytes = buffer.subarray(0, Math.min(bytesRead, MAX_READ_BYTES))
    const truncated = bytesRead > MAX_READ_BYTES
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { content: "", truncated, binary: true }
    return { content: bytes.toString("utf8"), truncated, binary: false }
  } finally {
    await handle.close()
  }
}

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

/** The real path `path` names under `root`, refusing `..`, absolute paths and symlinks that lead out of `root`. */
const resolveInside = (root: string, path: string) =>
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

  /**
   * Whether git ignores an entry of the folder `path`. `check-ignore` on every entry took 180 ms for a
   * 5,000-entry folder, so it only asks about the folder itself, and one `ls-files` lists the ignored
   * entries, stopping at ignored folders. Outside a git repository nothing is ignored.
   */
  const ignoredIn = (root: string, path: string) =>
    Effect.all(
      [
        path === ""
          ? Effect.succeed(false)
          : git.run(root, ["check-ignore", "--", path], { okExitCodes: [1] }).pipe(
              Effect.map((output) => output.trim() !== ""),
              Effect.orElseSucceed(() => false),
            ),
        // Fails inside an ignored folder, where the folder check already answers.
        git
          .run(root, [
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
            "--",
            path || ".",
          ])
          .pipe(
            Effect.map((output) => new Set(output.split("\0").map((ignored) => ignored.replace(/\/$/, "")))),
            Effect.orElseSucceed(() => new Set<string>()),
          ),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(
        ([folderIgnored, ignored]) =>
          (entryPath: string) =>
            folderIgnored || ignored.has(entryPath),
      ),
    )

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
      const entries = yield* readEntries(root, path, yield* resolveInside(root, path))
      const [isIgnored, changed] = yield* Effect.all([ignoredIn(root, path), changedPaths(root, path, baseRef)], {
        concurrency: "unbounded",
      })
      return entries
        .map((entry) => ({ ...entry, ignored: isIgnored(entry.path), gitStatus: statusOf(entry.path, changed) }))
        .toSorted(byKindThenName)
    })

  const read = (root: string, path: string) =>
    Effect.gen(function* () {
      yield* knownRoot(root)
      const file = yield* resolveInside(root, path)
      return yield* Effect.tryPromise({
        try: () => readStart(file),
        catch: () => new FsAccessError({ root, path, reason: "unreadable" }),
      })
    })

  const write = (root: string, path: string, content: string, expected: string | null) =>
    Effect.gen(function* () {
      yield* knownRoot(root)
      const file = yield* resolveInside(root, path)
      if (expected !== null) {
        const current = yield* Effect.tryPromise({
          try: () => readFile(file, "utf8"),
          catch: () => new FsAccessError({ root, path, reason: "unreadable" }),
        })
        if (current !== expected) return yield* new FsWriteConflict({ root, path })
      }
      yield* Effect.tryPromise({
        try: () => writeFile(file, content),
        catch: () => new FsAccessError({ root, path, reason: "unwritable" }),
      })
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
        const dir = yield* resolveInside(root, path).pipe(
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

  return Files.of({ list, read, write, watch })
})

export const layer = Layer.effect(Files, make)
