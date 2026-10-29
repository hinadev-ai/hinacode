import { join } from "node:path"
import { Context, Effect, FileSystem, Layer } from "effect"
import type { Thread } from "../../shared/domain.ts"
import { type PersistenceError, persistence } from "./errors.ts"
import { slugifyBranch } from "./automations/template.ts"

const MAX_SLUG_LENGTH = 40

/** `2026-10-29T08:05:09.123Z` becomes `20261029-080509`. */
const timestamp = (iso: string) => new Date(iso).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")

const slug = (title: string) =>
  slugifyBranch(title)
    .replaceAll("/", "-")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/[-.]+$/, "") || "thread"

/** A folder per thread under `<root>/<YYYYMMDD-HHmmss>-<slug>-<threadId>/` for the agent's throwaway files. */
export class Scratch extends Context.Service<
  Scratch,
  {
    /**
     * The thread's folder, made when it has none. It is found by its `-<threadId>` suffix, so a title change after
     * the first turn keeps the path, and the agent's instructions, the same.
     */
    readonly ensure: (thread: Thread) => Effect.Effect<string, PersistenceError>
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

      const remove = (threadId: string) =>
        find(threadId).pipe(
          Effect.flatMap((name) =>
            name === undefined ? Effect.void : fs.remove(join(root, name), { recursive: true, force: true }),
          ),
          Effect.mapError(persistence("scratch.remove")),
        )

      return Scratch.of({ ensure, remove })
    }),
  )
