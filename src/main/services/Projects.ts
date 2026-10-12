import { randomUUID } from "node:crypto"
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { SqlClient, SqlError, SqlSchema } from "effect/sql"
import { Project } from "../../shared/domain.ts"
import { nowIso } from "./clock.ts"
import {
  NotFoundError,
  type PersistenceError,
  ProjectPathTakenError,
  ProjectRootInvalidError,
  persistence,
} from "./errors.ts"

export interface CreateProject {
  readonly name: string
  readonly rootPath: string
  readonly setupScript: string | null
}

export interface UpdateProject {
  readonly id: string
  readonly name?: string | undefined
  readonly rootPath?: string | undefined
  readonly setupScript?: string | null | undefined
}

type WriteError = PersistenceError | ProjectPathTakenError | ProjectRootInvalidError

export class Projects extends Context.Service<
  Projects,
  {
    readonly list: Effect.Effect<ReadonlyArray<Project>, PersistenceError>
    readonly get: (id: string) => Effect.Effect<Project, PersistenceError | NotFoundError>
    readonly create: (input: CreateProject) => Effect.Effect<Project, WriteError>
    readonly update: (input: UpdateProject) => Effect.Effect<Project, WriteError | NotFoundError>
    readonly remove: (id: string) => Effect.Effect<void, PersistenceError>
  }
>()("kkcode/Projects") {}

const mapWriteError = (operation: string, rootPath: string) => (cause: unknown) =>
  SqlError.isSqlError(cause) && cause.reason._tag === "UniqueViolation"
    ? new ProjectPathTakenError({ rootPath })
    : persistence(operation)(cause)

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const fs = yield* FileSystem.FileSystem

  const findAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Project,
    execute: () => sql`SELECT * FROM project ORDER BY created_at`,
  })
  const findById = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Project,
    execute: (id) => sql`SELECT * FROM project WHERE id = ${id}`,
  })

  const get = (id: string) =>
    findById(id).pipe(
      Effect.mapError(persistence("projects.get")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new NotFoundError({ entity: "project", id })),
          onSome: Effect.succeed,
        }),
      ),
    )

  const ensureDirectory = (rootPath: string) =>
    fs.stat(rootPath).pipe(
      Effect.filterOrFail(
        (info) => info.type === "Directory",
        () => new ProjectRootInvalidError({ rootPath }),
      ),
      Effect.catchTag("PlatformError", () => Effect.fail(new ProjectRootInvalidError({ rootPath }))),
    )

  const create = (input: CreateProject) =>
    Effect.gen(function* () {
      yield* ensureDirectory(input.rootPath)
      const now = yield* nowIso
      const project: Project = { id: randomUUID(), ...input, createdAt: now, updatedAt: now }
      yield* sql`INSERT INTO project ${sql.insert(project)}`.pipe(
        Effect.mapError(mapWriteError("projects.create", input.rootPath)),
      )
      return project
    })

  const update = (input: UpdateProject) =>
    Effect.gen(function* () {
      const current = yield* get(input.id)
      if (input.rootPath !== undefined && input.rootPath !== current.rootPath) {
        yield* ensureDirectory(input.rootPath)
      }
      const next: Project = {
        ...current,
        name: input.name ?? current.name,
        rootPath: input.rootPath ?? current.rootPath,
        setupScript: input.setupScript === undefined ? current.setupScript : input.setupScript,
        updatedAt: yield* nowIso,
      }
      yield* sql`
        UPDATE project
        SET name = ${next.name}, root_path = ${next.rootPath}, setup_script = ${next.setupScript},
            updated_at = ${next.updatedAt}
        WHERE id = ${next.id}
      `.pipe(Effect.mapError(mapWriteError("projects.update", next.rootPath)))
      return next
    })

  return Projects.of({
    list: findAll(undefined).pipe(Effect.mapError(persistence("projects.list"))),
    get,
    create,
    update,
    remove: (id) =>
      sql`DELETE FROM project WHERE id = ${id}`.pipe(Effect.asVoid, Effect.mapError(persistence("projects.delete"))),
  })
})

export const layer = Layer.effect(Projects, make)
