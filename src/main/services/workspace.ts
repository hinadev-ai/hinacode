import { Effect, Option, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { chatFolder, ProjectKind } from "../../shared/domain.ts"
import { NotFoundError, persistence } from "./errors.ts"

export const ActiveWorkspace = Schema.Struct({
  cwd: Schema.String,
  rootPath: Schema.String,
  worktreeId: Schema.NullOr(Schema.String),
  baseRef: Schema.NullOr(Schema.String),
})
export type ActiveWorkspace = typeof ActiveWorkspace.Type

const WorkspaceRow = Schema.Struct({
  ...ActiveWorkspace.fields,
  kind: ProjectKind,
})

export const makeActiveWorkspace = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const find = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: WorkspaceRow,
    execute: (threadId) => sql`
      SELECT COALESCE(worktree.path, project.root_path) AS cwd, project.root_path, project.kind, worktree.id AS worktree_id, worktree.base_ref
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
          onSome: ({ kind, ...workspace }) => {
            const folder = chatFolder(workspace.rootPath, threadId)
            return Effect.succeed(kind === "chats" ? { ...workspace, cwd: folder, rootPath: folder } : workspace)
          },
        }),
      ),
    )
})
