import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { extname, isAbsolute, join, resolve, sep } from "node:path"
import { Cache, Context, Deferred, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { SqlClient, SqlError, SqlSchema } from "effect/sql"
import { Project, ProjectAction } from "../../shared/domain.ts"
import { type GitHubRepository, parseGitHubRepository, type RepositoryVisibility } from "../../shared/github.ts"
import { nowIso } from "./clock.ts"
import {
  NotFoundError,
  type PersistenceError,
  ProjectCloneCancelledError,
  ProjectFolderNotEmptyError,
  ProjectOriginTakenError,
  ProjectPathTakenError,
  ProjectInWslError,
  ProjectRootInvalidError,
  persistence,
} from "./errors.ts"
import { type CommandError, Git, LONG_TIMEOUT } from "./Git.ts"
import { Events } from "./Events.ts"
import { GitHub, type GitHubError } from "./GitHub.ts"

interface CreateProject {
  readonly name: string
  readonly rootPath: string
  readonly setupScript: string | null
}

interface CreateFolderProject extends CreateProject {
  readonly createRepository?: RepositoryVisibility | undefined
}

interface CloneProject extends CreateProject {
  readonly cloneId: string
  readonly repository: GitHubRepository
}

interface UpdateProject {
  readonly id: string
  readonly name?: string | undefined
  readonly rootPath?: string | undefined
  readonly setupScript?: string | null | undefined
  readonly linearReview?: boolean | undefined
  readonly actions?: ReadonlyArray<ProjectAction> | undefined
}

interface GroupProject {
  readonly id: string
  readonly name: string
}

type WriteError = PersistenceError | ProjectPathTakenError | ProjectRootInvalidError | ProjectInWslError

export class Projects extends Context.Service<
  Projects,
  {
    readonly list: Effect.Effect<ReadonlyArray<Project>, PersistenceError>
    readonly listWithRepositories: Effect.Effect<ReadonlyArray<Project>, PersistenceError>
    readonly get: (id: string) => Effect.Effect<Project, PersistenceError | NotFoundError>
    readonly create: (
      input: CreateFolderProject,
    ) => Effect.Effect<Project, WriteError | CommandError | GitHubError | ProjectOriginTakenError>
    readonly clone: (
      input: CloneProject,
    ) => Effect.Effect<Project, WriteError | ProjectFolderNotEmptyError | ProjectCloneCancelledError | CommandError>
    readonly cancelClone: (cloneId: string) => Effect.Effect<void>
    readonly update: (input: UpdateProject) => Effect.Effect<Project, WriteError | NotFoundError>
    readonly remove: (id: string) => Effect.Effect<void, PersistenceError>
    readonly ensureChats: (rootPath: string) => Effect.Effect<Project, PersistenceError | ProjectRootInvalidError>
    readonly ensureGroups: (groups: ReadonlyArray<GroupProject>, groupsDir: string) => Effect.Effect<void>
    readonly icon: (id: string) => Effect.Effect<string | null, PersistenceError | NotFoundError>
  }
>()("hinacode/Projects") {}

const HOME_PREFIX = sep === "\\" ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/

const WSL_SHARE = /^\\\\wsl(?:\.localhost|\$)\\/i

const resolveRoot = (rootPath: string) => {
  const expanded = rootPath.trim().replace(HOME_PREFIX, homedir())
  if (WSL_SHARE.test(expanded)) return Effect.fail(new ProjectInWslError({ rootPath }))
  return isAbsolute(expanded)
    ? Effect.succeed(resolve(expanded))
    : Effect.fail(new ProjectRootInvalidError({ rootPath }))
}

const succeeds = <E>(effect: Effect.Effect<unknown, E>) =>
  effect.pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

const mapWriteError = (operation: string, rootPath: string) => (cause: unknown) =>
  SqlError.isSqlError(cause) && cause.reason._tag === "UniqueViolation"
    ? new ProjectPathTakenError({ rootPath })
    : persistence(operation)(cause)

const ICON_TYPES: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" }
const ICON_NAMES = ["favicon.svg", "favicon.png", "favicon.ico", "icon.svg", "icon.png"]
const ICON_DIRS = ["", "public", "static", "app", "src/app", "assets", "apps/web/public", "apps/web/app"]
const ICON_PATHS = ICON_DIRS.flatMap((dir) => ICON_NAMES.map((name) => join(dir, name)))
const ICON_LIMIT_BYTES = 100 * 1024

const ProjectRow = Schema.Struct({
  ...Project.fields,
  linearReview: Schema.BooleanFromBit,
  actions: Schema.fromJsonString(Schema.Array(ProjectAction)),
})

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const fs = yield* FileSystem.FileSystem
  const git = yield* Git
  const github = yield* GitHub
  const events = yield* Events
  const cloneCancels = new Map<string, Deferred.Deferred<void>>()

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
  const repositories = yield* Cache.make({ lookup: repositoryOf, capacity: 256 })

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
      const { linearReview, actions, ...row }: Project = {
        id: randomUUID(),
        ...input,
        linearReview: false,
        kind: "folder",
        actions: [],
        createdAt: now,
        updatedAt: now,
      }
      yield* sql`INSERT INTO project ${sql.insert(row)}`.pipe(
        Effect.mapError(mapWriteError("projects.create", input.rootPath)),
      )
      yield* Cache.invalidate(repositories, input.rootPath)
      return { ...row, linearReview, actions }
    })

  const publish = (rootPath: string, visibility: RepositoryVisibility) =>
    Effect.gen(function* () {
      if (!(yield* succeeds(git.run(rootPath, ["rev-parse", "--is-inside-work-tree"])))) {
        yield* git.run(rootPath, ["init"])
      } else if (yield* succeeds(git.run(rootPath, ["remote", "get-url", "origin"]))) {
        return yield* new ProjectOriginTakenError({ rootPath })
      }
      if (!(yield* succeeds(git.run(rootPath, ["rev-parse", "--verify", "HEAD"])))) {
        yield* git.run(rootPath, ["commit", "--only", "--allow-empty", "-m", "Initial commit"], {
          timeout: LONG_TIMEOUT,
        })
      }
      yield* github.createRepository(rootPath, visibility)
    })

  const create = ({ createRepository, ...input }: CreateFolderProject) =>
    Effect.gen(function* () {
      const rootPath = yield* resolveRoot(input.rootPath)
      yield* makeDirectory(rootPath)
      if (createRepository !== undefined) yield* publish(rootPath, createRepository)
      return yield* insert({ ...input, rootPath })
    })

  const holdsClone = (rootPath: string, { owner, name }: GitHubRepository) =>
    git.run(rootPath, ["remote", "get-url", "origin"]).pipe(
      Effect.map((url) => {
        const origin = parseGitHubRepository(url)
        return origin !== null && `${origin.owner}/${origin.name}`.toLowerCase() === `${owner}/${name}`.toLowerCase()
      }),
      Effect.orElseSucceed(() => false),
    )

  const list = findAll(undefined).pipe(Effect.mapError(persistence("projects.list")))

  const listWithRepositories = list.pipe(
    Effect.flatMap((projects) =>
      Effect.forEach(
        projects,
        (project) =>
          Cache.get(repositories, project.rootPath).pipe(
            Effect.map((repository) => (repository === undefined ? project : { ...project, repository })),
          ),
        { concurrency: "unbounded" },
      ),
    ),
  )

  const cloneInto = (cloneId: string, repository: GitHubRepository, rootPath: string) =>
    Effect.gen(function* () {
      if (yield* holdsClone(rootPath, repository)) return
      yield* makeDirectory(rootPath)
      const entries = yield* fs
        .readDirectory(rootPath)
        .pipe(Effect.mapError(() => new ProjectRootInvalidError({ rootPath })))
      if (entries.length > 0) return yield* new ProjectFolderNotEmptyError({ rootPath })
      yield* github.clone(repository, rootPath, (progress) =>
        events.publish({ type: "project.cloneProgress", cloneId, progress }),
      )
    })

  const clone = ({ cloneId, repository, ...input }: CloneProject) =>
    Effect.gen(function* () {
      const cancel = yield* Deferred.make<void>()
      cloneCancels.set(cloneId, cancel)
      const rootPath = yield* resolveRoot(input.rootPath)
      const cancelled = Deferred.await(cancel).pipe(
        Effect.andThen(Effect.fail(new ProjectCloneCancelledError({ rootPath }))),
      )
      yield* Effect.raceFirst(cloneInto(cloneId, repository, rootPath), cancelled)
      return yield* insert({ ...input, rootPath })
    }).pipe(Effect.ensuring(Effect.sync(() => cloneCancels.delete(cloneId))))

  const cancelClone = (cloneId: string) =>
    Effect.suspend(() => {
      const cancel = cloneCancels.get(cloneId)
      return cancel === undefined ? Effect.void : Deferred.succeed(cancel, undefined)
    }).pipe(Effect.asVoid)

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

  const writeMissingFile = (path: string) =>
    fs.exists(path).pipe(
      Effect.flatMap((exists) => (exists ? Effect.void : fs.writeFileString(path, ""))),
      Effect.catchTag("PlatformError", () => Effect.fail(new ProjectRootInvalidError({ rootPath: path }))),
    )

  const ensureGroup = ({ id, name }: GroupProject, groupsDir: string) =>
    Effect.gen(function* () {
      const rootPath = join(groupsDir, id)
      yield* makeDirectory(join(rootPath, "skills"))
      yield* writeMissingFile(join(rootPath, "AGENTS.md"))
      const existing = yield* findById(id).pipe(Effect.mapError(persistence("projects.ensureGroups")))
      if (Option.isSome(existing) && existing.value.name === name && existing.value.rootPath === rootPath) return false
      const now = yield* nowIso
      const row = { id, name, rootPath, setupScript: null, kind: "group", createdAt: now, updatedAt: now }
      yield* sql`
        INSERT INTO project ${sql.insert(row)}
        ON CONFLICT (id) DO UPDATE SET name = excluded.name, root_path = excluded.root_path, updated_at = excluded.updated_at
      `.pipe(Effect.mapError(persistence("projects.ensureGroups")))
      return true
    })

  const ensureGroups = (groups: ReadonlyArray<GroupProject>, groupsDir: string) =>
    Effect.forEach(
      groups.filter(({ id }) => /^[\w-]+$/.test(id)),
      (group) =>
        ensureGroup(group, groupsDir).pipe(
          Effect.catch((error) =>
            Effect.logWarning(`could not create the folder of group ${group.id}`, error).pipe(Effect.as(false)),
          ),
        ),
    ).pipe(
      Effect.flatMap((changed) =>
        changed.includes(true) ? events.publish({ type: "projects.changed" }) : Effect.void,
      ),
    )

  const update = (input: UpdateProject) =>
    Effect.gen(function* () {
      const current = yield* get(input.id)
      const rootPath = input.rootPath === undefined ? current.rootPath : yield* resolveRoot(input.rootPath)
      if (rootPath !== current.rootPath) yield* ensureDirectory(rootPath)
      const next: Project = {
        ...current,
        name: input.name ?? current.name,
        rootPath,
        setupScript: input.setupScript === undefined ? current.setupScript : input.setupScript,
        linearReview: input.linearReview ?? current.linearReview,
        actions: input.actions ?? current.actions,
        updatedAt: yield* nowIso,
      }
      yield* sql`
        UPDATE project
        SET name = ${next.name}, root_path = ${next.rootPath}, setup_script = ${next.setupScript},
            linear_review = ${next.linearReview ? 1 : 0}, actions = ${JSON.stringify(next.actions)},
            updated_at = ${next.updatedAt}
        WHERE id = ${next.id}
      `.pipe(Effect.mapError(mapWriteError("projects.update", next.rootPath)))
      yield* Cache.invalidate(repositories, current.rootPath)
      yield* Cache.invalidate(repositories, next.rootPath)
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
    cancelClone,
    update,
    icon,
    ensureChats,
    ensureGroups,
    remove: (id) =>
      sql`DELETE FROM project WHERE id = ${id}`.pipe(Effect.asVoid, Effect.mapError(persistence("projects.delete"))),
  })
})

export const layer = Layer.effect(Projects, make)
