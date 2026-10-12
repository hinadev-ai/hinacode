import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import type { ProviderId } from "../../shared/agent.ts"
import { type AccessMode, Thread, type ThreadStatus } from "../../shared/domain.ts"
import { nowIso } from "./clock.ts"
import {
  NotFoundError,
  type PersistenceError,
  persistence,
  ThreadStartedError,
  type WorktreeBusyError,
  type WorktreeTakenError,
} from "./errors.ts"
import { slugifyBranch } from "./automations/template.ts"
import { type CommandError, Git } from "./Git.ts"
import { Projects } from "./Projects.ts"
import { Settings } from "./Settings.ts"
import { makeActiveWorkspace } from "./workspace.ts"
import { Worktrees } from "./Worktrees.ts"

/** Enough for `@` completion in a large monorepo without sending the renderer a huge payload. */
const MAX_LISTED_FILES = 50_000

/** A placeholder title for a thread nobody has described yet. It doubles as its branch name. */
export const randomName = () => `thread-${randomUUID().slice(0, 5)}`

/** The thread table row. SQLite has no boolean, so `fast_mode` is a bit. */
const ThreadRow = Schema.Struct({ ...Thread.fields, fastMode: Schema.BooleanFromBit })

export interface CreateThread {
  readonly projectId: string
  readonly title: string
  readonly provider: ProviderId
  readonly model: string
  /** Creates a worktree for the thread first; the thread points at it while its setup script runs. */
  readonly worktree?: { readonly branch: string; readonly baseRef: string } | undefined
  /** Defaults to `user`. */
  readonly createdBy?: string | undefined
}

export interface UpdateThread {
  readonly id: string
  readonly title?: string | undefined
  /** Refused once the thread has a message. */
  readonly provider?: ProviderId | undefined
  readonly model?: string | undefined
  /** Null goes back to the model's default effort. */
  readonly effort?: string | null | undefined
  readonly fastMode?: boolean | undefined
  readonly accessMode?: AccessMode | undefined
  readonly status?: ThreadStatus | undefined
  readonly sortIndex?: number | undefined
  readonly providerSessionId?: string | undefined
}

export class Threads extends Context.Service<
  Threads,
  {
    readonly list: Effect.Effect<ReadonlyArray<Thread>, PersistenceError>
    readonly get: (id: string) => Effect.Effect<Thread, PersistenceError | NotFoundError>
    readonly create: (
      input: CreateThread,
    ) => Effect.Effect<Thread, PersistenceError | NotFoundError | CommandError | WorktreeTakenError>
    readonly update: (
      input: UpdateThread,
    ) => Effect.Effect<Thread, PersistenceError | NotFoundError | ThreadStartedError>
    /** Files in the thread's working directory that git tracks or would track, for `@` mentions. */
    readonly listFiles: (
      id: string,
    ) => Effect.Effect<ReadonlyArray<string>, PersistenceError | NotFoundError | CommandError>
    /** Whether the thread has any message yet. */
    readonly started: (id: string) => Effect.Effect<boolean, PersistenceError>
    /**
     * Moves a thread that has not started into a new worktree forked from `baseRef`, or from the project's
     * current branch when `baseRef` is empty. The branch is named after the thread's title.
     */
    readonly attachWorktree: (
      id: string,
      baseRef: string,
    ) => Effect.Effect<
      Thread,
      PersistenceError | NotFoundError | CommandError | WorktreeTakenError | ThreadStartedError
    >
    /** Marks the thread settled and removes its worktree, deleting the branch only if it is merged. */
    readonly settle: (
      id: string,
    ) => Effect.Effect<Thread, PersistenceError | NotFoundError | CommandError | WorktreeBusyError>
    /** `removeWorktree` first removes the thread's worktree the way settling does. */
    readonly remove: (
      id: string,
      options?: { readonly removeWorktree?: boolean | undefined },
    ) => Effect.Effect<void, PersistenceError | NotFoundError | CommandError | WorktreeBusyError>
    /** Turns do not survive a restart, so threads left mid-turn by a crash go back to idle. */
    readonly resetInterrupted: Effect.Effect<void, PersistenceError>
  }
>()("kkcode/Threads") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const projects = yield* Projects
  const worktrees = yield* Worktrees
  const git = yield* Git
  const settings = yield* Settings
  const activeWorkspace = yield* makeActiveWorkspace

  const encodeRow = Schema.encodeEffect(ThreadRow)

  const findAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ThreadRow,
    execute: () => sql`SELECT * FROM thread ORDER BY project_id, sort_index`,
  })
  const findById = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ThreadRow,
    execute: (id) => sql`SELECT * FROM thread WHERE id = ${id}`,
  })
  const nextSortIndex = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ next: Schema.Number }),
    execute: (projectId) =>
      sql`SELECT COALESCE(MAX(sort_index) + 1, 0) AS next FROM thread WHERE project_id = ${projectId}`,
  })

  const findStarted = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ started: Schema.Number }),
    execute: (id) => sql`SELECT EXISTS (SELECT 1 FROM message WHERE thread_id = ${id}) AS started`,
  })
  const started = (id: string) =>
    findStarted(id).pipe(
      Effect.map((row) => row.started === 1),
      Effect.mapError(persistence("threads.started")),
    )

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

  const create = ({ worktree: worktreeInput, createdBy = "user", ...input }: CreateThread) =>
    Effect.gen(function* () {
      yield* projects.get(input.projectId)
      const worktree = worktreeInput
        ? yield* worktrees.create({ projectId: input.projectId, ...worktreeInput })
        : undefined
      const { next } = yield* nextSortIndex(input.projectId).pipe(Effect.mapError(persistence("threads.create")))
      const { defaultAccessMode } = yield* settings.get
      const now = yield* nowIso
      const thread: Thread = {
        id: randomUUID(),
        ...input,
        worktreeId: worktree?.id ?? null,
        effort: null,
        fastMode: false,
        accessMode: defaultAccessMode,
        providerSessionId: null,
        status: "idle",
        sortIndex: next,
        createdBy,
        createdAt: now,
        updatedAt: now,
      }
      const row = yield* encodeRow(thread).pipe(Effect.mapError(persistence("threads.create")))
      yield* sql`INSERT INTO thread ${sql.insert(row)}`.pipe(Effect.mapError(persistence("threads.create")))
      return thread
    })

  const update = (input: UpdateThread) =>
    Effect.gen(function* () {
      const current = yield* get(input.id)
      if (input.provider !== undefined && input.provider !== current.provider && (yield* started(input.id))) {
        return yield* new ThreadStartedError({ id: input.id })
      }
      return yield* write(current, input)
    })

  const write = (current: Thread, input: UpdateThread) =>
    Effect.gen(function* () {
      const next: Thread = {
        ...current,
        title: input.title ?? current.title,
        provider: input.provider ?? current.provider,
        model: input.model ?? current.model,
        effort: input.effort === undefined ? current.effort : input.effort,
        fastMode: input.fastMode ?? current.fastMode,
        accessMode: input.accessMode ?? current.accessMode,
        status: input.status ?? current.status,
        sortIndex: input.sortIndex ?? current.sortIndex,
        providerSessionId: input.providerSessionId ?? current.providerSessionId,
        updatedAt: yield* nowIso,
      }
      yield* sql`
        UPDATE thread
        SET title = ${next.title}, provider = ${next.provider}, model = ${next.model}, effort = ${next.effort},
            fast_mode = ${next.fastMode ? 1 : 0}, access_mode = ${next.accessMode}, status = ${next.status},
            sort_index = ${next.sortIndex}, provider_session_id = ${next.providerSessionId},
            updated_at = ${next.updatedAt}
        WHERE id = ${next.id}
      `.pipe(Effect.mapError(persistence("threads.update")))
      return next
    })

  const attachWorktree = (id: string, baseRef: string) =>
    Effect.gen(function* () {
      const thread = yield* get(id)
      if (thread.worktreeId !== null || (yield* started(id))) return yield* new ThreadStartedError({ id })
      const worktree = yield* worktrees.create({
        projectId: thread.projectId,
        branch: `kk/${slugifyBranch(thread.title) || randomName()}`,
        baseRef: baseRef.trim() || (yield* worktrees.currentBranch(thread.projectId)),
      })
      const updatedAt = yield* nowIso
      yield* sql`UPDATE thread SET worktree_id = ${worktree.id}, updated_at = ${updatedAt} WHERE id = ${id}`.pipe(
        Effect.mapError(persistence("threads.attachWorktree")),
      )
      return { ...thread, worktreeId: worktree.id, updatedAt }
    })

  const listFiles = (id: string) =>
    Effect.gen(function* () {
      const { cwd } = yield* activeWorkspace(id)
      const output = yield* git.run(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
      return output
        .split("\0")
        .filter((path) => path !== "")
        .slice(0, MAX_LISTED_FILES)
    })

  const removeOwnWorktree = (thread: Thread) =>
    thread.worktreeId ? worktrees.remove(thread.worktreeId, "ifMerged", thread.id) : Effect.void

  const settle = (id: string) =>
    Effect.gen(function* () {
      yield* removeOwnWorktree(yield* get(id))
      return yield* write(yield* get(id), { id, status: "settled" })
    })

  const remove = (id: string, options?: { readonly removeWorktree?: boolean | undefined }) =>
    Effect.gen(function* () {
      if (options?.removeWorktree) yield* removeOwnWorktree(yield* get(id))
      yield* sql`DELETE FROM thread WHERE id = ${id}`.pipe(Effect.mapError(persistence("threads.delete")))
    })

  return Threads.of({
    list: findAll(undefined).pipe(Effect.mapError(persistence("threads.list"))),
    get,
    create,
    update,
    started,
    attachWorktree,
    listFiles,
    settle,
    remove,
    resetInterrupted: sql`
      UPDATE thread SET status = 'idle' WHERE status IN ('running', 'awaiting_approval')
    `.pipe(Effect.asVoid, Effect.mapError(persistence("threads.resetInterrupted"))),
  })
})

export const layer = Layer.effect(Threads, make)
