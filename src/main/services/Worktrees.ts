import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { Worktree } from "../../shared/domain.ts"
import { type PersistenceError, persistence } from "./errors.ts"

export class Worktrees extends Context.Service<
  Worktrees,
  {
    readonly list: Effect.Effect<ReadonlyArray<Worktree>, PersistenceError>
  }
>()("kkcode/Worktrees") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const findAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Worktree,
    execute: () => sql`SELECT * FROM worktree ORDER BY created_at`,
  })

  return Worktrees.of({
    list: findAll(undefined).pipe(Effect.mapError(persistence("worktrees.list"))),
  })
})

export const layer = Layer.effect(Worktrees, make)
