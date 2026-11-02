import { join } from "node:path"
import { Context, Effect, FileSystem, Layer } from "effect"
import type { Thread } from "../../shared/domain.ts"
import { type PersistenceError, persistence } from "./errors.ts"
import { slugifyBranch } from "./automations/template.ts"

const MAX_SLUG_LENGTH = 40
const REMOVING_SUFFIX = ".removing"

// FIXME: Electron's fs reads `.asar` files as folders, so a recursive delete of a checkout with Electron installed fails
const fsWithoutAsar = (process.getBuiltinModule("original-fs") ??
  process.getBuiltinModule("node:fs")) as typeof import("node:fs")

const deleteTree = (path: string) =>
  Effect.tryPromise(() => fsWithoutAsar.promises.rm(path, { recursive: true, force: true }))

const timestamp = (iso: string) => new Date(iso).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")

const slug = (title: string) =>
  slugifyBranch(title)
    .replaceAll("/", "-")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/[-.]+$/, "") || "thread"

export class Scratch extends Context.Service<
  Scratch,
  {
    readonly ensure: (thread: Thread) => Effect.Effect<string, PersistenceError>
    readonly writeSecret: (thread: Thread, name: string, value: string) => Effect.Effect<string, PersistenceError>
    readonly remove: (threadId: string) => Effect.Effect<void, PersistenceError>
  }
>()("hinacode/Scratch") {}

export const layer = (root: string, deleteFolder: (path: string) => Effect.Effect<void, unknown> = deleteTree) =>
  Layer.effect(
    Scratch,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const names = fs
        .exists(root)
        .pipe(Effect.flatMap((exists) => (exists ? fs.readDirectory(root) : Effect.succeed([]))))

      const find = (threadId: string) =>
        names.pipe(Effect.map((all) => all.find((name) => name.endsWith(`-${threadId}`))))

      const deleteInBackground = (name: string) =>
        Effect.forkDetach(
          deleteFolder(join(root, name)).pipe(
            Effect.catchCause((cause) => Effect.logWarning("scratch folder deletion failed", name, cause)),
          ),
        )

      yield* names.pipe(
        Effect.flatMap((all) =>
          Effect.forEach(
            all.filter((name) => name.endsWith(REMOVING_SUFFIX)),
            deleteInBackground,
            { discard: true },
          ),
        ),
        Effect.ignore,
      )

      const ensure = (thread: Thread) =>
        Effect.gen(function* () {
          const existing = yield* find(thread.id)
          if (existing !== undefined) return join(root, existing)
          const folder = join(root, `${timestamp(thread.createdAt)}-${slug(thread.title)}-${thread.id}`)
          yield* fs.makeDirectory(folder, { recursive: true })
          return folder
        }).pipe(Effect.mapError(persistence("scratch.ensure")))

      const writeSecret = (thread: Thread, name: string, value: string) =>
        Effect.gen(function* () {
          const folder = join(yield* ensure(thread), "secrets")
          yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 })
          const path = join(folder, name)
          yield* fs.writeFileString(path, value, { mode: 0o600 })
          return path
        }).pipe(Effect.mapError(persistence("scratch.writeSecret")))

      const remove = (threadId: string) =>
        Effect.gen(function* () {
          const name = yield* find(threadId)
          if (name === undefined) return
          const removing = `${name}${REMOVING_SUFFIX}`
          yield* fs.rename(join(root, name), join(root, removing))
          yield* deleteInBackground(removing)
        }).pipe(Effect.mapError(persistence("scratch.remove")))

      return Scratch.of({ ensure, writeSecret, remove })
    }),
  )
