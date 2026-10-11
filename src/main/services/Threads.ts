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
  readonly providerSessionId?: string | undefined
}

export class Threads extends Context.Service<
  Threads,
  {
    readonly list: Effect.Effect<ReadonlyArray<Thread>, PersistenceError>
    readonly get: (id: string) => Effect.Effect<Thread, PersistenceError | NotFoundError>
    readonly create: (input: CreateThread) => Effect.Effect<Thread, PersistenceError | NotFoundError>
    readonly update: (input: UpdateThread) => Effect.Effect<Thread, PersistenceError | NotFoundError>
    readonly remove: (id: string) => Effect.Effect<void, PersistenceError>
    /** Turns do not survive a restart, so threads left mid-turn by a crash go back to idle. */
    readonly resetInterrupted: Effect.Effect<void, PersistenceError>
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

  const update = (input: UpdateThread) =>
    Effect.gen(function* () {
      const current = yield* get(input.id)
      const next: Thread = {
        ...current,
        title: input.title ?? current.title,
        model: input.model ?? current.model,
        status: input.status ?? current.status,
        sortIndex: input.sortIndex ?? current.sortIndex,
        providerSessionId: input.providerSessionId ?? current.providerSessionId,
        updatedAt: yield* nowIso,
      }
      yield* sql`
        UPDATE thread
        SET title = ${next.title}, model = ${next.model}, status = ${next.status},
            sort_index = ${next.sortIndex}, provider_session_id = ${next.providerSessionId},
            updated_at = ${next.updatedAt}
        WHERE id = ${next.id}
      `.pipe(Effect.mapError(persistence("threads.update")))
      return next
    })

  return Threads.of({
    list: findAll(undefined).pipe(Effect.mapError(persistence("threads.list"))),
    get,
    create,
    update,
    remove: (id) =>
      sql`DELETE FROM thread WHERE id = ${id}`.pipe(Effect.asVoid, Effect.mapError(persistence("threads.delete"))),
    resetInterrupted: sql`
      UPDATE thread SET status = 'idle' WHERE status IN ('running', 'awaiting_approval')
    `.pipe(Effect.asVoid, Effect.mapError(persistence("threads.resetInterrupted"))),
  })
})

export const layer = Layer.effect(Threads, make)
