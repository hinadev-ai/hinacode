import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { dirname, isAbsolute } from "node:path"
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { SqlClient, SqlError, SqlSchema } from "effect/sql"
import { Project } from "../../shared/domain.ts"
import { type GitHubRepository, parseGitHubRepository } from "../../shared/github.ts"
import { nowIso } from "./clock.ts"
import {
  NotFoundError,
  type PersistenceError,
  ProjectPathTakenError,
  ProjectRootInvalidError,
  persistence,
} from "./errors.ts"
import { type CommandError, Git } from "./Git.ts"
import { GitHub } from "./GitHub.ts"

export interface CreateProject {
  readonly name: string
  readonly rootPath: string
  readonly setupScript: string | null
}

export interface CloneProject extends CreateProject {
  readonly repository: GitHubRepository
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
    /**
     * Clones the repository into `rootPath` (a leading `~` is the home directory) and adds it. A folder
     * that already holds a clone of the same repository is added as it is.
     */
    readonly clone: (input: CloneProject) => Effect.Effect<Project, WriteError | CommandError>
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
  const git = yield* Git
  const github = yield* GitHub

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

  const holdsClone = (rootPath: string, { owner, name }: GitHubRepository) =>
    git.run(rootPath, ["remote", "get-url", "origin"]).pipe(
      Effect.map((url) => {
        const origin = parseGitHubRepository(url)
        return origin?.owner.toLowerCase() === owner.toLowerCase() && origin.name === name
      }),
      Effect.orElseSucceed(() => false),
    )

  const clone = ({ repository, ...input }: CloneProject) =>
    Effect.gen(function* () {
      const rootPath = input.rootPath.trim().replace(/^~(?=$|\/)/, homedir())
      if (!isAbsolute(rootPath)) return yield* new ProjectRootInvalidError({ rootPath: input.rootPath })
      if (!(yield* holdsClone(rootPath, repository))) {
        yield* fs
          .makeDirectory(dirname(rootPath), { recursive: true })
          .pipe(Effect.mapError(() => new ProjectRootInvalidError({ rootPath: dirname(rootPath) })))
        yield* github.clone(repository, rootPath)
      }
      return yield* create({ ...input, rootPath })
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
    clone,
    update,
    remove: (id) =>
      sql`DELETE FROM project WHERE id = ${id}`.pipe(Effect.asVoid, Effect.mapError(persistence("projects.delete"))),
  })
})

export const layer = Layer.effect(Projects, make)
