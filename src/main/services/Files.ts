import { type Dirent, watch as watchFs } from "node:fs"
import { open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import {
  type ChangedFileStatus,
  chatFolder,
  type FsEntry,
  type FsEntryKind,
  type FsFileContent,
} from "../../shared/domain.ts"
import { mimeOf } from "../../shared/media.ts"
import { isInside } from "../security.ts"
import { type PersistenceError, persistence } from "./errors.ts"
import { Events } from "./Events.ts"
import { Git, parseNameStatus } from "./Git.ts"

const reasons = {
  unknownRoot: "is not a project root, worktree or chat folder",
  outsideRoot: "is not inside",
  unreadable: "cannot be read in",
  unwritable: "cannot be written in",
  tooLarge: "is too large to preview from",
} as const

const MAX_PREVIEW_BYTES = 6 * 1024 * 1024

export class FsAccessError extends Schema.TaggedError<FsAccessError>()("FsAccessError", {
  root: Schema.String,
  path: Schema.String,
  reason: Schema.Literals(["unknownRoot", "outsideRoot", "unreadable", "unwritable", "tooLarge"]),
}) {
  override get message(): string {
    return this.reason === "unknownRoot"
      ? `${this.root} ${reasons.unknownRoot}`
      : `"${this.path}" ${reasons[this.reason]} ${this.root}`
  }
}

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
    readonly list: (
      root: string,
      path: string,
    ) => Effect.Effect<ReadonlyArray<FsEntry>, FsAccessError | PersistenceError>
    readonly resolve: (root: string, path: string) => Effect.Effect<string, FsAccessError | PersistenceError>
    readonly read: (root: string, path: string) => Effect.Effect<FsFileContent, FsAccessError | PersistenceError>
    readonly preview: (
      root: string,
      path: string,
    ) => Effect.Effect<{ readonly dataUrl: string }, FsAccessError | PersistenceError>
    readonly write: (
      root: string,
      path: string,
      content: string,
      expected: string | null,
    ) => Effect.Effect<void, FsAccessError | FsWriteConflict | PersistenceError>
    readonly watch: (
      root: string,
      paths: ReadonlyArray<string>,
    ) => Effect.Effect<void, FsAccessError | PersistenceError>
  }
>()("hinacode/Files") {}

const WATCH_DEBOUNCE_MS = 100

export const MAX_READ_BYTES = 1024 * 1024

const BINARY_SNIFF_BYTES = 8000

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

const porcelainStatus = (code: string): ChangedFileStatus => {
  if (code === "??") return "untracked"
  if (code.includes("U") || code === "DD" || code === "AA") return "conflict"
  if (code.startsWith("A")) return "added"
  if (code.includes("D")) return "deleted"
  return "modified"
}

const summarize = (statuses: ReadonlyArray<ChangedFileStatus>): ChangedFileStatus | null => {
  const [first] = statuses
  if (first === undefined) return null
  if (statuses.includes("conflict")) return "conflict"
  return first !== "deleted" && statuses.every((status) => status === first) ? first : "modified"
}

const statusOf = (path: string, changed: ReadonlyMap<string, ChangedFileStatus>) => {
  const below = `${path}/`
  const statuses: Array<ChangedFileStatus> = []
  for (const [changedPath, status] of changed) {
    const untrackedAbove = changedPath.endsWith("/") && path.startsWith(changedPath)
    if (changedPath === path || changedPath.startsWith(below) || untrackedAbove) statuses.push(status)
  }
  return summarize(statuses)
}

const isIgnored = (path: string, ignored: ReadonlyArray<string>) =>
  ignored.some(
    (ignoredPath) => ignoredPath === path || (ignoredPath.endsWith("/") && `${path}/`.startsWith(ignoredPath)),
  )

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

const chatFolderParts = (root: string) => {
  const cut = Math.max(root.lastIndexOf("/"), root.lastIndexOf("\\"))
  const parts = { chatsRoot: root.slice(0, cut), threadId: root.slice(cut + 1) }
  return cut > 0 && chatFolder(parts.chatsRoot, parts.threadId) === root ? parts : { chatsRoot: null, threadId: null }
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const git = yield* Git
  const events = yield* Events

  const findRoot = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ baseRef: Schema.NullOr(Schema.String) }),
    execute: (root) => {
      const { chatsRoot, threadId } = chatFolderParts(root)
      return sql`
        SELECT NULL AS base_ref FROM project WHERE root_path = ${root}
        UNION ALL
        SELECT base_ref FROM worktree WHERE path = ${root} AND status != 'removed'
        UNION ALL
        SELECT NULL AS base_ref FROM thread JOIN project ON project.id = thread.project_id
        WHERE project.kind = 'chats' AND project.root_path = ${chatsRoot} AND thread.id = ${threadId}
          AND thread.status != 'archived'
      `
    },
  })

  const knownRoot = (root: string) =>
    Effect.gen(function* () {
      const rows = yield* findRoot(root).pipe(Effect.mapError(persistence("files.root")))
      if (rows.length === 0) return yield* new FsAccessError({ root, path: "", reason: "unknownRoot" })
      return rows.find((row) => row.baseRef !== null)?.baseRef ?? null
    })

  const prefixes = new Map<string, string>()

  const prefixOf = (root: string) =>
    Effect.gen(function* () {
      const cached = prefixes.get(root)
      if (cached !== undefined) return cached
      const prefix = (yield* git.run(root, ["rev-parse", "--show-prefix"])).trim()
      prefixes.set(root, prefix)
      return prefix
    })

  const committed = (root: string, pathspec: string, baseRef: string | null) =>
    baseRef === null
      ? Effect.succeed([])
      : git
          .run(root, [
            "diff",
            "--name-status",
            "-z",
            "--no-renames",
            "--relative",
            "--merge-base",
            baseRef,
            "--",
            pathspec,
          ])
          .pipe(
            Effect.map(parseNameStatus),
            Effect.orElseSucceed(() => []),
          )

  const gitState = (root: string, path: string, baseRef: string | null) =>
    Effect.gen(function* () {
      const pathspec = path === "" ? "." : path
      const [prefix, porcelain, fromBase] = yield* Effect.all(
        [
          prefixOf(root),
          git.run(root, [
            "status",
            "--porcelain",
            "-z",
            "--no-renames",
            "--untracked-files=normal",
            "--ignored=matching",
            "--",
            pathspec,
          ]),
          committed(root, pathspec, baseRef),
        ],
        { concurrency: "unbounded" },
      )
      const changed = new Map(fromBase.map((file) => [file.path, file.status]))
      const ignored: Array<string> = []
      for (const record of porcelain.split("\0")) {
        const repoPath = record.slice(3)
        if (record.length < 4 || !repoPath.startsWith(prefix)) continue
        const code = record.slice(0, 2)
        const relativePath = repoPath.slice(prefix.length)
        const status = porcelainStatus(code)
        if (code === "!!") ignored.push(relativePath)
        else if (status === "conflict" || !changed.has(relativePath)) changed.set(relativePath, status)
      }
      return { changed, ignored }
    }).pipe(Effect.orElseSucceed(() => ({ changed: new Map<string, ChangedFileStatus>(), ignored: [] })))

  const list = (root: string, path: string) =>
    Effect.gen(function* () {
      const baseRef = yield* knownRoot(root)
      const entries = yield* readEntries(root, path, yield* resolveInside(root, path))
      const { changed, ignored } = yield* gitState(root, path, baseRef)
      return entries
        .map((entry) => ({
          ...entry,
          ignored: isIgnored(entry.path, ignored),
          gitStatus: statusOf(entry.path, changed),
        }))
        .toSorted(byKindThenName)
    })

  const resolve = (root: string, path: string) =>
    Effect.gen(function* () {
      yield* knownRoot(root)
      return yield* resolveInside(root, path)
    })

  const read = (root: string, path: string) =>
    Effect.gen(function* () {
      const file = yield* resolve(root, path)
      return yield* Effect.tryPromise({
        try: () => readStart(file),
        catch: () => new FsAccessError({ root, path, reason: "unreadable" }),
      })
    })

  const preview = (root: string, path: string) =>
    Effect.gen(function* () {
      const file = yield* resolve(root, path)
      const unreadable = () => new FsAccessError({ root, path, reason: "unreadable" })
      const { size } = yield* Effect.tryPromise({ try: () => stat(file), catch: unreadable })
      if (size > MAX_PREVIEW_BYTES) return yield* new FsAccessError({ root, path, reason: "tooLarge" })
      const data = yield* Effect.tryPromise({ try: () => readFile(file), catch: unreadable })
      return { dataUrl: `data:${mimeOf(path)};base64,${data.toString("base64")}` }
    })

  const write = (root: string, path: string, content: string, expected: string | null) =>
    Effect.gen(function* () {
      const file = yield* resolve(root, path)
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

  const watchers = new Map<string, Map<string, () => void>>()

  const watchDir = (root: string, path: string, dir: string) =>
    Effect.try(() => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const changed = () => {
        clearTimeout(timer)
        timer = setTimeout(() => Effect.runFork(events.publish({ type: "fs.changed", root, path })), WATCH_DEBOUNCE_MS)
      }
      const watcher = watchFs(dir, changed)
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

  return Files.of({ list, resolve, read, preview, write, watch })
})

export const layer = Layer.effect(Files, make)
