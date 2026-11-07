import { Effect, FileSystem, Option, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { chatFolder, ProjectKind } from "../../shared/domain.ts"
import { FolderMissingError, NotFoundError, persistence } from "./errors.ts"

const workspaceFields = {
  cwd: Schema.String,
  rootPath: Schema.String,
  worktreeId: Schema.NullOr(Schema.String),
  baseRef: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
}

export const ActiveWorkspace = Schema.Struct({ ...workspaceFields, worktreeRemoved: Schema.Boolean })
export type ActiveWorkspace = typeof ActiveWorkspace.Type

const WorkspaceRow = Schema.Struct({
  ...workspaceFields,
  assignedWorktreeId: Schema.NullOr(Schema.String),
  kind: ProjectKind,
  folderOwner: Schema.String,
})

export const makeRequireFolder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return (path: string) =>
    fs.exists(path).pipe(
      Effect.orElseSucceed(() => true),
      Effect.flatMap((exists) => (exists ? Effect.void : Effect.fail(new FolderMissingError({ path })))),
    )
})

export const makeActiveWorkspace = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const requireFolder = yield* makeRequireFolder
  const find = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: WorkspaceRow,
    execute: (threadId) => sql`
      SELECT COALESCE(worktree.path, project.root_path) AS cwd, project.root_path, project.kind, worktree.id AS worktree_id, worktree.base_ref, worktree.branch,
        thread.worktree_id AS assigned_worktree_id, COALESCE(thread.side_of, thread.id) AS folder_owner
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
          onSome: ({ kind, folderOwner, assignedWorktreeId, ...row }) => {
            const workspace = { ...row, worktreeRemoved: assignedWorktreeId !== null && row.worktreeId === null }
            const folder = chatFolder(workspace.rootPath, folderOwner)
            return Effect.succeed(kind === "chats" ? { ...workspace, cwd: folder, rootPath: folder } : workspace)
          },
        }),
      ),
      Effect.tap((workspace) => requireFolder(workspace.cwd)),
    )
})
