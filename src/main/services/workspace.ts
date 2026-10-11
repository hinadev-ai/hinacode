import { Effect, Option, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { NotFoundError, persistence } from "./errors.ts"

export const ActiveWorkspace = Schema.Struct({
  cwd: Schema.String,
  /** The ref the worktree branched from, null when the thread works in the project root. */
  baseRef: Schema.NullOr(Schema.String),
})
export type ActiveWorkspace = typeof ActiveWorkspace.Type

/**
 * Resolves where a thread works now: its worktree, or the project root once the worktree is removed.
 * Removing a worktree keeps `thread.worktree_id` pointing at the removed row so the history still shows
 * where the thread ran, so agent runs, MCP tools and the ports panel must all resolve through here.
 */
export const makeActiveWorkspace = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const find = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ActiveWorkspace,
    execute: (threadId) => sql`
      SELECT COALESCE(worktree.path, project.root_path) AS cwd, worktree.base_ref
      FROM thread
      JOIN project ON project.id = thread.project_id
      LEFT JOIN worktree ON worktree.id = thread.worktree_id AND worktree.status != 'removed'
      WHERE thread.id = ${threadId}
    `,
  })
  return (threadId: string) =>
    find(threadId).pipe(
      Effect.mapError(persistence("workspace.active")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new NotFoundError({ entity: "thread", id: threadId })),
          onSome: Effect.succeed,
        }),
      ),
    )
})
