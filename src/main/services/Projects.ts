import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { extname, isAbsolute, join } from "node:path"
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { SqlClient, SqlError, SqlSchema } from "effect/sql"
import { Project } from "../../shared/domain.ts"
import { type GitHubRepository, parseGitHubRepository } from "../../shared/github.ts"
import { nowIso } from "./clock.ts"
import {
  NotFoundError,
  type PersistenceError,
  ProjectFolderNotEmptyError,
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
  readonly linearReview?: boolean | undefined
}

type WriteError = PersistenceError | ProjectPathTakenError | ProjectRootInvalidError

export class Projects extends Context.Service<
  Projects,
  {
    readonly list: Effect.Effect<ReadonlyArray<Project>, PersistenceError>
    readonly listWithRepositories: Effect.Effect<ReadonlyArray<Project>, PersistenceError>
    readonly get: (id: string) => Effect.Effect<Project, PersistenceError | NotFoundError>
    readonly create: (input: CreateProject) => Effect.Effect<Project, WriteError>
    readonly clone: (
      input: CloneProject,
    ) => Effect.Effect<Project, WriteError | ProjectFolderNotEmptyError | CommandError>
    readonly update: (input: UpdateProject) => Effect.Effect<Project, WriteError | NotFoundError>
    readonly remove: (id: string) => Effect.Effect<void, PersistenceError>
    readonly ensureChats: (rootPath: string) => Effect.Effect<Project, PersistenceError | ProjectRootInvalidError>
    readonly icon: (id: string) => Effect.Effect<string | null, PersistenceError | NotFoundError>
  }
>()("hinacode/Projects") {}

const resolveRoot = (rootPath: string) => {
  const resolved = rootPath.trim().replace(/^~(?=$|\/)/, homedir())
  return isAbsolute(resolved) ? Effect.succeed(resolved) : Effect.fail(new ProjectRootInvalidError({ rootPath }))
}

const mapWriteError = (operation: string, rootPath: string) => (cause: unknown) =>
  SqlError.isSqlError(cause) && cause.reason._tag === "UniqueViolation"
    ? new ProjectPathTakenError({ rootPath })
    : persistence(operation)(cause)

const ICON_TYPES: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" }
const ICON_NAMES = ["favicon.svg", "favicon.png", "favicon.ico", "icon.svg", "icon.png"]
const ICON_DIRS = ["", "public", "static", "app", "src/app", "assets", "apps/web/public", "apps/web/app"]
const ICON_PATHS = ICON_DIRS.flatMap((dir) => ICON_NAMES.map((name) => join(dir, name)))
const ICON_LIMIT_BYTES = 100 * 1024

const ProjectRow = Schema.Struct({ ...Project.fields, linearReview: Schema.BooleanFromBit })

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const fs = yield* FileSystem.FileSystem
  const git = yield* Git
  const github = yield* GitHub

  const findAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectRow,
    execute: () => sql`SELECT * FROM project ORDER BY created_at`,
  })
  const findById = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ProjectRow,
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

  const makeDirectory = (rootPath: string) =>
    Effect.gen(function* () {
      if (yield* fs.exists(rootPath)) return yield* ensureDirectory(rootPath)
      yield* fs.makeDirectory(rootPath, { recursive: true })
    }).pipe(Effect.catchTag("PlatformError", () => Effect.fail(new ProjectRootInvalidError({ rootPath }))))

  const insert = (input: CreateProject) =>
    Effect.gen(function* () {
      const now = yield* nowIso
      const { linearReview, ...row }: Project = {
        id: randomUUID(),
        ...input,
        linearReview: false,
        kind: "folder",
        createdAt: now,
        updatedAt: now,
      }
      yield* sql`INSERT INTO project ${sql.insert(row)}`.pipe(
        Effect.mapError(mapWriteError("projects.create", input.rootPath)),
      )
      return { ...row, linearReview }
    })

  const create = (input: CreateProject) =>
    Effect.gen(function* () {
      const rootPath = yield* resolveRoot(input.rootPath)
      yield* makeDirectory(rootPath)
      return yield* insert({ ...input, rootPath })
    })

  const holdsClone = (rootPath: string, { owner, name }: GitHubRepository) =>
    git.run(rootPath, ["remote", "get-url", "origin"]).pipe(
      Effect.map((url) => {
        const origin = parseGitHubRepository(url)
        return origin?.owner.toLowerCase() === owner.toLowerCase() && origin.name === name
      }),
      Effect.orElseSucceed(() => false),
    )

  const repositoryOf = (rootPath: string) =>
    Effect.all({
      url: git.run(rootPath, ["remote", "get-url", "origin"]),
      prefix: git.run(rootPath, ["rev-parse", "--show-prefix"]),
    }).pipe(
      Effect.map(({ url, prefix }) => {
        const origin = parseGitHubRepository(url)
        if (origin === null) return undefined
        const folder = prefix.trim().replace(/\/$/, "")
        return [origin.owner, origin.name, folder].filter(Boolean).join("/").toLowerCase()
      }),
      Effect.orElseSucceed(() => undefined),
    )

  const list = findAll(undefined).pipe(Effect.mapError(persistence("projects.list")))

  const listWithRepositories = list.pipe(
    Effect.flatMap((projects) =>
      Effect.forEach(
        projects,
        (project) =>
          repositoryOf(project.rootPath).pipe(
            Effect.map((repository) => (repository === undefined ? project : { ...project, repository })),
          ),
        { concurrency: "unbounded" },
      ),
    ),
  )

  const clone = ({ repository, ...input }: CloneProject) =>
    Effect.gen(function* () {
      const rootPath = yield* resolveRoot(input.rootPath)
      if (!(yield* holdsClone(rootPath, repository))) {
        yield* makeDirectory(rootPath)
        const entries = yield* fs
          .readDirectory(rootPath)
          .pipe(Effect.mapError(() => new ProjectRootInvalidError({ rootPath })))
        if (entries.length > 0) return yield* new ProjectFolderNotEmptyError({ rootPath })
        yield* github.clone(repository, rootPath)
      }
      return yield* insert({ ...input, rootPath })
    })

  const findChats = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectRow,
    execute: () => sql`SELECT * FROM project WHERE kind = 'chats'`,
  })

  const ensureChats = (rootPath: string) =>
    Effect.gen(function* () {
      yield* makeDirectory(rootPath)
      const now = yield* nowIso
      const row = {
        id: randomUUID(),
        name: "Chats",
        rootPath,
        setupScript: null,
        kind: "chats",
        createdAt: now,
        updatedAt: now,
      }
      yield* sql`
        INSERT INTO project ${sql.insert(row)}
        ON CONFLICT (kind) WHERE kind = 'chats' DO UPDATE SET root_path = excluded.root_path
      `.pipe(Effect.mapError(persistence("projects.ensureChats")))
      return yield* findChats(undefined).pipe(Effect.mapError(persistence("projects.ensureChats")))
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
        linearReview: input.linearReview ?? current.linearReview,
        updatedAt: yield* nowIso,
      }
      yield* sql`
        UPDATE project
        SET name = ${next.name}, root_path = ${next.rootPath}, setup_script = ${next.setupScript},
            linear_review = ${next.linearReview ? 1 : 0}, updated_at = ${next.updatedAt}
        WHERE id = ${next.id}
      `.pipe(Effect.mapError(mapWriteError("projects.update", next.rootPath)))
      return next
    })

  const readIcon = (path: string) =>
    Effect.gen(function* () {
      const info = yield* fs.stat(path)
      if (info.type !== "File" || Number(info.size) > ICON_LIMIT_BYTES) return null
      const bytes = yield* fs.readFile(path)
      return `data:${ICON_TYPES[extname(path)]};base64,${Buffer.from(bytes).toString("base64")}`
    }).pipe(Effect.orElseSucceed(() => null))

  const icon = (id: string) =>
    Effect.gen(function* () {
      const { rootPath } = yield* get(id)
      for (const path of ICON_PATHS) {
        const found = yield* readIcon(join(rootPath, path))
        if (found !== null) return found
      }
      return null
    })

  return Projects.of({
    list,
    listWithRepositories,
    get,
    create,
    clone,
    update,
    icon,
    ensureChats,
    remove: (id) =>
      sql`DELETE FROM project WHERE id = ${id}`.pipe(Effect.asVoid, Effect.mapError(persistence("projects.delete"))),
  })
})

export const layer = Layer.effect(Projects, make)
