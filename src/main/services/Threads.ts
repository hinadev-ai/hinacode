import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import type { ProviderId } from "../../shared/agent.ts"
import { Thread, type ThreadStatus } from "../../shared/domain.ts"
import { nowIso } from "./clock.ts"
import { NotFoundError, type PersistenceError, persistence } from "./errors.ts"
import { Projects } from "./Projects.ts"

export interface CreateThread {
  readonly projectId: string
  readonly title: string
  readonly provider: ProviderId
  readonly model: string
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
    readonly create: (input: CreateThread) => Effect.Effect<Thread, PersistenceError | NotFoundError>
    readonly update: (input: UpdateThread) => Effect.Effect<Thread, PersistenceError | NotFoundError>
    readonly remove: (id: string) => Effect.Effect<void, PersistenceError>
  }
>()("kkcode/Threads") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const projects = yield* Projects

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

  const create = (input: CreateThread) =>
    Effect.gen(function* () {
      yield* projects.get(input.projectId)
      const { next } = yield* nextSortIndex(input.projectId).pipe(Effect.mapError(persistence("threads.create")))
      const now = yield* nowIso
      const thread: Thread = {
        id: randomUUID(),
        ...input,
        worktreeId: null,
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
      const current = yield* findById(input.id).pipe(
        Effect.mapError(persistence("threads.update")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFoundError({ entity: "thread", id: input.id })),
            onSome: Effect.succeed,
          }),
        ),
      )
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

  return Threads.of({
    list: findAll(undefined).pipe(Effect.mapError(persistence("threads.list"))),
    create,
    update,
    remove: (id) =>
      sql`DELETE FROM thread WHERE id = ${id}`.pipe(Effect.asVoid, Effect.mapError(persistence("threads.delete"))),
  })
})

export const layer = Layer.effect(Threads, make)
