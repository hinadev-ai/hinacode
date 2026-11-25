import { createHash, randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, FileSystem, Layer } from "effect"
import type { Thread } from "../../shared/domain.ts"
import { type PersistenceError, persistence } from "./errors.ts"
import { slugifyBranch } from "./branchName.ts"
import { Secrets, threadSecretPrefix } from "./Secrets.ts"

const MAX_SLUG_LENGTH = 40
const SECRETS_FOLDER = "secrets"
const THREAD_ID_SUFFIX = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
const REMOVING_SUFFIX = ".removing"
const TMP_ROOT_HASH_LENGTH = 6
const TMP_ID_LENGTH = 8

// FIXME: Electron's fs reads `.asar` files as folders, so a recursive delete of a checkout with Electron installed fails
const fsWithoutAsar = (process.getBuiltinModule("original-fs") ??
  process.getBuiltinModule("node:fs")) as typeof import("node:fs")

const deleteTree = (path: string) =>
  Effect.tryPromise(() => fsWithoutAsar.promises.rm(path, { recursive: true, force: true }))

const timestamp = (iso: string) => new Date(iso).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")

type FolderOwner = Pick<Thread, "id" | "title" | "createdAt">

const slug = (title: string) =>
  slugifyBranch(title)
    .replaceAll("/", "-")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/[-.]+$/, "") || "thread"

export class Scratch extends Context.Service<
  Scratch,
  {
    readonly ensure: (thread: FolderOwner) => Effect.Effect<string, PersistenceError>
    readonly ensureTmp: (threadId: string) => Effect.Effect<string | null>
    readonly writeSecret: (thread: FolderOwner, name: string, value: string) => Effect.Effect<string, PersistenceError>
    readonly removeSecrets: (threadId: string) => Effect.Effect<void>
    readonly unreadableBy: (threadId: string) => Effect.Effect<ReadonlyArray<string>>
    readonly remove: (threadId: string) => Effect.Effect<void, PersistenceError>
    readonly removeTmp: (threadId: string) => Effect.Effect<void>
  }
>()("hinacode/Scratch") {}

export const layer = (
  root: string,
  {
    tmpRoot = join(tmpdir(), `hc-${createHash("sha256").update(root).digest("hex").slice(0, TMP_ROOT_HASH_LENGTH)}`),
    deleteFolder = deleteTree,
    privatePaths = [],
  }: {
    readonly tmpRoot?: string
    readonly deleteFolder?: (path: string) => Effect.Effect<void, unknown>
    readonly privatePaths?: ReadonlyArray<string>
  } = {},
) =>
  Layer.effect(
    Scratch,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const secrets = yield* Secrets

      const namesIn = (folder: string) =>
        fs.exists(folder).pipe(Effect.flatMap((exists) => (exists ? fs.readDirectory(folder) : Effect.succeed([]))))
      const names = namesIn(root)

      const find = (threadId: string) =>
        names.pipe(Effect.map((all) => all.find((name) => name.endsWith(`-${threadId}`))))

      const tmpFolder = (threadId: string) => join(tmpRoot, threadId.slice(0, TMP_ID_LENGTH))

      const ownsTmpRoot = Effect.gen(function* () {
        yield* fs.makeDirectory(tmpRoot, { recursive: true, mode: 0o700 })
        const stats = yield* Effect.tryPromise(() => fsWithoutAsar.promises.lstat(tmpRoot))
        if (!stats.isDirectory()) return false
        return process.platform === "win32" || (stats.uid === process.getuid?.() && (stats.mode & 0o022) === 0)
      }).pipe(Effect.orElseSucceed(() => false))

      const deleteInBackground = (path: string) =>
        Effect.forkDetach(
          deleteFolder(path).pipe(
            Effect.catchCause((cause) => Effect.logWarning("scratch folder deletion failed", path, cause)),
          ),
        )

      const moveAsideAndDelete = (path: string) =>
        Effect.gen(function* () {
          if (!(yield* fs.exists(path))) return
          const removing = `${path}-${randomUUID()}${REMOVING_SUFFIX}`
          yield* fs.rename(path, removing)
          yield* deleteInBackground(removing)
        })

      const deleteLeftovers = (folder: string) =>
        namesIn(folder).pipe(
          Effect.flatMap((all) =>
            Effect.forEach(
              all.filter((name) => name.endsWith(REMOVING_SUFFIX)),
              (name) => deleteInBackground(join(folder, name)),
              { discard: true },
            ),
          ),
          Effect.ignore,
        )

      const threadFolders = names.pipe(Effect.map((all) => all.filter((name) => !name.endsWith(REMOVING_SUFFIX))))

      const adoptSecretsIn = (folder: string) =>
        Effect.gen(function* () {
          const threadId = THREAD_ID_SUFFIX.exec(folder)?.[1]
          const secretsFolder = join(root, folder, SECRETS_FOLDER)
          if (threadId === undefined || !(yield* fs.exists(secretsFolder))) return
          for (const name of yield* fs.readDirectory(secretsFolder)) {
            const key = `${threadSecretPrefix(threadId)}${name}`
            if (yield* secrets.has(key)) continue
            yield* secrets.set(key, yield* fs.readFileString(join(secretsFolder, name)))
          }
        })

      const deleteSecretsIn = (folder: string) =>
        adoptSecretsIn(folder).pipe(
          Effect.andThen(fs.remove(join(root, folder, SECRETS_FOLDER), { recursive: true, force: true })),
          Effect.catchCause((cause) => Effect.logWarning("thread secrets removal failed", folder, cause)),
        )

      yield* deleteLeftovers(root)
      if (yield* ownsTmpRoot) yield* deleteLeftovers(tmpRoot)
      yield* threadFolders.pipe(
        Effect.flatMap((all) => Effect.forEach(all, deleteSecretsIn, { discard: true, concurrency: 16 })),
        Effect.ignore,
      )

      const ensure = (thread: FolderOwner) =>
        Effect.gen(function* () {
          const existing = yield* find(thread.id)
          if (existing !== undefined) return join(root, existing)
          const folder = join(root, `${timestamp(thread.createdAt)}-${slug(thread.title)}-${thread.id}`)
          yield* fs.makeDirectory(folder, { recursive: true })
          return folder
        }).pipe(Effect.mapError(persistence("scratch.ensure")))

      const ensureTmp = (threadId: string) =>
        Effect.gen(function* () {
          if (!(yield* ownsTmpRoot)) {
            yield* Effect.logWarning(
              "thread tmp folder skipped: its root is not a private folder of this user",
              tmpRoot,
            )
            return null
          }
          const folder = tmpFolder(threadId)
          yield* fs.makeDirectory(folder, { recursive: true })
          return folder
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("thread tmp folder creation failed", tmpRoot, cause).pipe(Effect.as(null)),
          ),
        )

      const writeSecret = (thread: FolderOwner, name: string, value: string) =>
        Effect.gen(function* () {
          const folder = join(yield* ensure(thread), SECRETS_FOLDER)
          yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 })
          const path = join(folder, name)
          yield* fs.writeFileString(path, value, { mode: 0o600 })
          return path
        }).pipe(Effect.mapError(persistence("scratch.writeSecret")))

      const removeTmp = (threadId: string) =>
        Effect.gen(function* () {
          if (yield* ownsTmpRoot) yield* moveAsideAndDelete(tmpFolder(threadId))
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("thread tmp folder removal failed", tmpRoot, cause)))

      const remove = (threadId: string) =>
        Effect.gen(function* () {
          const name = yield* find(threadId)
          if (name !== undefined) yield* moveAsideAndDelete(join(root, name))
          yield* removeTmp(threadId)
        }).pipe(Effect.mapError(persistence("scratch.remove")))

      const removeSecrets = (threadId: string) =>
        Effect.try(() => {
          if (!fsWithoutAsar.existsSync(root)) return
          const name = fsWithoutAsar.readdirSync(root).find((entry) => entry.endsWith(`-${threadId}`))
          if (name !== undefined)
            fsWithoutAsar.rmSync(join(root, name, SECRETS_FOLDER), { recursive: true, force: true })
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("thread secrets removal failed", threadId, cause)))

      const unreadableBy = (threadId: string) =>
        threadFolders.pipe(
          Effect.map((all) => [
            ...privatePaths,
            ...all.filter((name) => !name.endsWith(`-${threadId}`)).map((name) => join(root, name, "**")),
          ]),
          Effect.orElseSucceed(() => privatePaths),
        )

      return Scratch.of({ ensure, ensureTmp, writeSecret, removeSecrets, unreadableBy, remove, removeTmp })
    }),
  )
