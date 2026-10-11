import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import type { ProviderId } from "../../shared/agent.ts"
import { Thread, type ThreadStatus } from "../../shared/domain.ts"
import { nowIso } from "./clock.ts"
import { NotFoundError, type PersistenceError, persistence } from "./errors.ts"
import type { CommandError } from "./Git.ts"
import { Projects } from "./Projects.ts"
import { Worktrees } from "./Worktrees.ts"

export interface CreateThread {
  readonly projectId: string
  readonly title: string
  readonly provider: ProviderId
  readonly model: string
  /** Creates a worktree for the thread first; the thread points at it while its setup script runs. */
  readonly worktree?: { readonly branch: string; readonly baseRef: string } | undefined
}

export interface UpdateThread {
  readonly id: string
  readonly title?: string | undefined
  readonly model?: string | undefined
  readonly status?: ThreadStatus | undefined
  readonly sortIndex?: number | undefined
}

export class Threads extends Context.Service<
  Threads,
  {
    readonly list: Effect.Effect<ReadonlyArray<Thread>, PersistenceError>
    readonly get: (id: string) => Effect.Effect<Thread, PersistenceError | NotFoundError>
    readonly create: (input: CreateThread) => Effect.Effect<Thread, PersistenceError | NotFoundError | CommandError>
    readonly update: (input: UpdateThread) => Effect.Effect<Thread, PersistenceError | NotFoundError>
    /** Marks the thread settled and removes its worktree, deleting the branch only if it is merged. */
    readonly settle: (id: string) => Effect.Effect<Thread, PersistenceError | NotFoundError | CommandError>
    readonly remove: (id: string) => Effect.Effect<void, PersistenceError>
  }
>()("kkcode/Threads") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const projects = yield* Projects
  const worktrees = yield* Worktrees

  const findAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Thread,
    execute: () => sql`SELECT * FROM thread ORDER BY project_id, sort_index`,
  })
  const findById = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Thread,
    execute: (id) => sql`SELECT * FROM thread WHERE id = ${id}`,
  })
  const nextSortIndex = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ next: Schema.Number }),
    execute: (projectId) =>
      sql`SELECT COALESCE(MAX(sort_index) + 1, 0) AS next FROM thread WHERE project_id = ${projectId}`,
  })

  const get = (id: string) =>
    findById(id).pipe(
      Effect.mapError(persistence("threads.get")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new NotFoundError({ entity: "thread", id })),
          onSome: Effect.succeed,
        }),
      ),
    )

  const create = ({ worktree: worktreeInput, ...input }: CreateThread) =>
    Effect.gen(function* () {
      yield* projects.get(input.projectId)
      const worktree = worktreeInput
        ? yield* worktrees.create({ projectId: input.projectId, ...worktreeInput })
        : undefined
      const { next } = yield* nextSortIndex(input.projectId).pipe(Effect.mapError(persistence("threads.create")))
      const now = yield* nowIso
      const thread: Thread = {
        id: randomUUID(),
        ...input,
        worktreeId: worktree?.id ?? null,
        providerSessionId: null,
        status: "idle",
        sortIndex: next,
        createdAt: now,
        updatedAt: now,
      }
      yield* sql`INSERT INTO thread ${sql.insert(thread)}`.pipe(Effect.mapError(persistence("threads.create")))
      return thread
    })

  const update = (input: UpdateThread) =>
    Effect.gen(function* () {
      const current = yield* get(input.id)
      const next: Thread = {
        ...current,
        title: input.title ?? current.title,
        model: input.model ?? current.model,
        status: input.status ?? current.status,
        sortIndex: input.sortIndex ?? current.sortIndex,
        updatedAt: yield* nowIso,
      }
      yield* sql`
        UPDATE thread
        SET title = ${next.title}, model = ${next.model}, status = ${next.status},
            sort_index = ${next.sortIndex}, updated_at = ${next.updatedAt}
        WHERE id = ${next.id}
      `.pipe(Effect.mapError(persistence("threads.update")))
      return next
    })

  const settle = (id: string) =>
    Effect.gen(function* () {
      const thread = yield* get(id)
      if (thread.worktreeId) {
        const worktree = yield* worktrees.get(thread.worktreeId)
        if (worktree.status !== "removed") yield* worktrees.remove(worktree.id, "ifMerged")
      }
      return yield* update({ id, status: "settled" })
    })

  return Threads.of({
    list: findAll(undefined).pipe(Effect.mapError(persistence("threads.list"))),
    get,
    create,
    update,
    settle,
    remove: (id) =>
      sql`DELETE FROM thread WHERE id = ${id}`.pipe(Effect.asVoid, Effect.mapError(persistence("threads.delete"))),
  })
})

export const layer = Layer.effect(Threads, make)
