import { join } from "node:path"
import { Context, Effect, FileSystem, Layer } from "effect"
import type { Thread } from "../../shared/domain.ts"
import { type PersistenceError, persistence } from "./errors.ts"
import { slugifyBranch } from "./automations/template.ts"

const MAX_SLUG_LENGTH = 40

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

export const layer = (root: string) =>
  Layer.effect(
    Scratch,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const find = (threadId: string) =>
        fs.exists(root).pipe(
          Effect.flatMap((exists) => (exists ? fs.readDirectory(root) : Effect.succeed([]))),
          Effect.map((names) => names.find((name) => name.endsWith(`-${threadId}`))),
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
        find(threadId).pipe(
          Effect.flatMap((name) =>
            name === undefined ? Effect.void : fs.remove(join(root, name), { recursive: true, force: true }),
          ),
          Effect.mapError(persistence("scratch.remove")),
        )

      return Scratch.of({ ensure, writeSecret, remove })
    }),
  )
