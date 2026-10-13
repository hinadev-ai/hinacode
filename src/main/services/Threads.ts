import { randomUUID } from "node:crypto"
import { Context, Effect, FileSystem, Layer, Option, type PlatformError, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { ProviderId } from "../../shared/agent.ts"
import { UsageLimit } from "../../shared/limits.ts"
import {
  type AccessMode,
  type Changes,
  type ChangesScope,
  isThreadBusy,
  Thread,
  type ThreadStatus,
  type WorktreeSource,
} from "../../shared/domain.ts"
import { parseGitHubRepository } from "../../shared/github.ts"
import { nowIso } from "./clock.ts"
import {
  NotFoundError,
  type PersistenceError,
  persistence,
  PullRequestElsewhereError,
  ThreadBusyError,
  ThreadStartedError,
  type WorktreeBusyError,
  type WorktreeTakenError,
} from "./errors.ts"
import { AgentAccounts } from "./AgentAccounts.ts"
import { slugifyBranch } from "./automations/template.ts"
import { type CommandError, Git } from "./Git.ts"
import { GitHub, type GitHubError } from "./GitHub.ts"
import { Projects } from "./Projects.ts"
import { diffWorkingTree, snapshotWorkingTree } from "./workingTree.ts"
import { Settings } from "./Settings.ts"
import { Terminals } from "./Terminals.ts"
import { makeActiveWorkspace } from "./workspace.ts"
import { Worktrees } from "./Worktrees.ts"

/** Enough for `@` completion in a large monorepo without sending the renderer a huge payload. */
const MAX_LISTED_FILES = 50_000

/** A placeholder title for a thread nobody has described yet. It doubles as its branch name. */
export const randomName = () => `thread-${randomUUID().slice(0, 5)}`

/** The thread table row. SQLite has no boolean, so `fast_mode` is a bit. */
const ThreadRow = Schema.Struct({
  ...Thread.fields,
  fastMode: Schema.BooleanFromBit,
  usageLimit: Schema.NullOr(Schema.fromJsonString(UsageLimit)),
})

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
  /** Refused once the thread has a message. Moves the thread to the new agent's default account unless `accountId` is given. */
  readonly provider?: ProviderId | undefined
  /** Refused once the thread has a provider session, whose transcript lives in the account's home. */
  readonly accountId?: string | null | undefined
  readonly model?: string | undefined
  /** Null goes back to the model's default effort. */
  readonly effort?: string | null | undefined
  readonly fastMode?: boolean | undefined
  readonly accessMode?: AccessMode | undefined
  readonly status?: ThreadStatus | undefined
  readonly usageLimit?: UsageLimit | null | undefined
  readonly sortIndex?: number | undefined
  readonly providerSessionId?: string | undefined
}

// Reordering in the sidebar is not activity, so it must not make a thread look fresh.
const onlyReorders = (input: UpdateThread) =>
  Object.entries(input).every(([key, value]) => key === "id" || key === "sortIndex" || value === undefined)

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
     * Moves a thread that has not started into a new worktree. A `branch` source forks a branch named after
     * the thread's title from `baseRef`, or from the project's current branch when it is empty. A
     * `pullRequest` source checks out that pull request, and `pullRequestUrl` names it so it can be linked.
     */
    readonly attachWorktree: (
      id: string,
      source: WorktreeSource,
    ) => Effect.Effect<
      { readonly thread: Thread; readonly pullRequestUrl: string | null },
      | PersistenceError
      | NotFoundError
      | CommandError
      | WorktreeTakenError
      | ThreadStartedError
      | GitHubError
      | Schema.SchemaError
      | PullRequestElsewhereError
    >
    /**
     * Marks the thread archived and ends its terminals. With `Settings.archive.removeWorktree` on, it first
     * removes the thread's worktree, deleting the branch only if it is merged. Refuses while a turn runs.
     */
    readonly archive: (
      id: string,
    ) => Effect.Effect<Thread, PersistenceError | NotFoundError | CommandError | WorktreeBusyError | ThreadBusyError>
    readonly unarchive: (id: string) => Effect.Effect<Thread, PersistenceError | NotFoundError>
    /** `removeWorktree` first removes the thread's worktree the way archiving does. */
    readonly remove: (
      id: string,
      options?: { readonly removeWorktree?: boolean | undefined },
    ) => Effect.Effect<void, PersistenceError | NotFoundError | CommandError | WorktreeBusyError>
    /**
     * What changed in the thread's working tree: since its worktree forked (`worktree`), or since its
     * latest turn started (`turn`). Null when the scope has no base: no live worktree, or no turn snapshot.
     */
    readonly changes: (
      id: string,
      scope: ChangesScope,
    ) => Effect.Effect<Changes | null, PersistenceError | NotFoundError | CommandError | PlatformError.PlatformError>
    /** Records `cwd` as it is now as the base of the `turn` scope. Outside a git checkout the base is cleared. */
    readonly snapshotTurnBase: (id: string, cwd: string) => Effect.Effect<void, PersistenceError>
    /** Turns do not survive a restart, so threads left mid-turn by a crash go back to idle. */
    readonly resetInterrupted: Effect.Effect<void, PersistenceError>
  }
>()("kkcode/Threads") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const projects = yield* Projects
  const worktrees = yield* Worktrees
  const git = yield* Git
  const github = yield* GitHub
  const settings = yield* Settings
  const accounts = yield* AgentAccounts
  const terminals = yield* Terminals
  const activeWorkspace = yield* makeActiveWorkspace
  const gitContext = yield* Effect.context<Git | FileSystem.FileSystem>()

  const encodeRow = Schema.encodeEffect(ThreadRow)

  // A database written by a newer build can hold threads of providers this build has no agent
  // for. Listing skips them instead of failing every caller (the sidebar, the limit checker).
  const findAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ThreadRow,
    execute: () =>
      sql`SELECT * FROM thread WHERE ${sql.in("provider", [...ProviderId.literals])} ORDER BY project_id, sort_index`,
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

  const findTurnBase = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ turnBaseTree: Schema.NullOr(Schema.String) }),
    execute: (id) => sql`SELECT turn_base_tree FROM thread WHERE id = ${id}`,
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
      const { defaultAccessMode, defaultAccount } = yield* settings.get
      const now = yield* nowIso
      const thread: Thread = {
        id: randomUUID(),
        ...input,
        worktreeId: worktree?.id ?? null,
        effort: null,
        fastMode: false,
        accessMode: defaultAccessMode,
        accountId: defaultAccount[input.provider],
        providerSessionId: null,
        status: "idle",
        usageLimit: null,
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
      const switchesAgent = input.provider !== undefined && input.provider !== current.provider
      if (switchesAgent && (yield* started(input.id))) {
        return yield* new ThreadStartedError({ id: input.id })
      }
      const provider = input.provider ?? current.provider
      const accountId =
        input.accountId !== undefined
          ? input.accountId
          : switchesAgent
            ? (yield* settings.get).defaultAccount[provider]
            : current.accountId
      if (accountId !== current.accountId) {
        if (current.providerSessionId !== null) return yield* new ThreadStartedError({ id: input.id })
        // An account of another agent is as unknown to this thread as a missing one.
        if (accountId !== null && (yield* accounts.get(accountId)).provider !== provider) {
          return yield* new NotFoundError({ entity: "account", id: accountId })
        }
      }
      return yield* write(current, { ...input, accountId: accountId === current.accountId ? undefined : accountId })
    })

  const write = (current: Thread, input: UpdateThread) =>
    Effect.gen(function* () {
      const next: Thread = {
        ...current,
        title: input.title ?? current.title,
        provider: input.provider ?? current.provider,
        accountId: input.accountId === undefined ? current.accountId : input.accountId,
        model: input.model ?? current.model,
        effort: input.effort === undefined ? current.effort : input.effort,
        fastMode: input.fastMode ?? current.fastMode,
        accessMode: input.accessMode ?? current.accessMode,
        status: input.status ?? current.status,
        usageLimit:
          input.status !== undefined && input.status !== "limited"
            ? null
            : input.usageLimit === undefined
              ? current.usageLimit
              : input.usageLimit,
        sortIndex: input.sortIndex ?? current.sortIndex,
        providerSessionId: input.providerSessionId ?? current.providerSessionId,
        updatedAt: onlyReorders(input) ? current.updatedAt : yield* nowIso,
      }
      yield* sql`
        UPDATE thread
        SET title = ${next.title}, provider = ${next.provider}, account_id = ${next.accountId}, model = ${next.model},
            effort = ${next.effort},
            fast_mode = ${next.fastMode ? 1 : 0}, access_mode = ${next.accessMode}, status = ${next.status},
            sort_index = ${next.sortIndex}, provider_session_id = ${next.providerSessionId},
            updated_at = ${next.updatedAt}, usage_limit = ${next.usageLimit === null ? null : JSON.stringify(next.usageLimit)}
        WHERE id = ${next.id}
      `.pipe(Effect.mapError(persistence("threads.update")))
      return next
    })

  const pullRequestWorktree = (projectId: string, selector: string) =>
    Effect.gen(function* () {
      const { rootPath } = yield* projects.get(projectId)
      const head = yield* github.pullRequestHead(rootPath, selector)
      // gh resolves a URL wherever it points, but the head is fetched from this project's origin.
      const origin = yield* github.repository(rootPath)
      const target = parseGitHubRepository(head.url)
      if (
        origin &&
        target &&
        `${origin.owner}/${origin.name}`.toLowerCase() !== `${target.owner}/${target.name}`.toLowerCase()
      ) {
        return yield* new PullRequestElsewhereError({ url: head.url, repository: `${origin.owner}/${origin.name}` })
      }
      return { worktree: yield* worktrees.createFromPullRequest(projectId, head), pullRequestUrl: head.url }
    })

  const attachWorktree = (id: string, source: WorktreeSource) =>
    Effect.gen(function* () {
      const thread = yield* get(id)
      if (thread.worktreeId !== null || (yield* started(id))) return yield* new ThreadStartedError({ id })
      const { worktree, pullRequestUrl } =
        source._tag === "pullRequest"
          ? yield* pullRequestWorktree(thread.projectId, source.selector)
          : {
              worktree: yield* worktrees.create({
                projectId: thread.projectId,
                branch: `kk/${slugifyBranch(thread.title) || randomName()}`,
                baseRef: source.baseRef.trim() || (yield* worktrees.currentBranch(thread.projectId)),
              }),
              pullRequestUrl: null,
            }
      const updatedAt = yield* nowIso
      yield* sql`UPDATE thread SET worktree_id = ${worktree.id}, updated_at = ${updatedAt} WHERE id = ${id}`.pipe(
        Effect.mapError(persistence("threads.attachWorktree")),
      )
      return { thread: { ...thread, worktreeId: worktree.id, updatedAt }, pullRequestUrl }
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

  const changes = (id: string, scope: ChangesScope) =>
    Effect.gen(function* () {
      if (scope === "worktree") {
        const { worktreeId } = yield* get(id)
        return worktreeId === null ? null : yield* worktrees.changes(worktreeId)
      }
      const row = yield* findTurnBase(id).pipe(Effect.mapError(persistence("threads.turnBase")))
      if (Option.isNone(row)) return yield* new NotFoundError({ entity: "thread", id })
      const { turnBaseTree } = row.value
      if (turnBaseTree === null) return null
      const { cwd } = yield* activeWorkspace(id)
      return yield* diffWorkingTree(cwd, turnBaseTree).pipe(Effect.provideContext(gitContext))
    })

  const snapshotTurnBase = (id: string, cwd: string) =>
    Effect.gen(function* () {
      const tree = yield* snapshotWorkingTree(cwd).pipe(
        Effect.provideContext(gitContext),
        Effect.orElseSucceed(() => null),
      )
      yield* sql`UPDATE thread SET turn_base_tree = ${tree} WHERE id = ${id}`.pipe(
        Effect.mapError(persistence("threads.snapshotTurnBase")),
      )
    })

  const removeOwnWorktree = (thread: Thread) =>
    thread.worktreeId ? worktrees.remove(thread.worktreeId, "ifMerged", thread.id) : Effect.void

  const archive = (id: string) =>
    worktrees.exclusive(
      Effect.gen(function* () {
        const thread = yield* get(id)
        if (isThreadBusy(thread.status)) return yield* new ThreadBusyError({ id })
        if ((yield* settings.get).archive.removeWorktree && thread.worktreeId) {
          yield* worktrees.removeWhileExclusive(thread.worktreeId, "ifMerged", id)
        }
        yield* terminals.closeThread(id)
        yield* sql`
          UPDATE thread SET status = 'archived', usage_limit = NULL, updated_at = ${yield* nowIso} WHERE id = ${id}
        `.pipe(Effect.mapError(persistence("threads.archive")))
        return yield* get(id)
      }),
    )

  const unarchive = (id: string) => Effect.flatMap(get(id), (thread) => write(thread, { id, status: "idle" }))

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
    changes,
    snapshotTurnBase,
    archive,
    unarchive,
    remove,
    resetInterrupted: sql`
      UPDATE thread SET status = 'idle' WHERE status IN ('running', 'awaiting_approval')
    `.pipe(Effect.asVoid, Effect.mapError(persistence("threads.resetInterrupted"))),
  })
})

export const layer = Layer.effect(Threads, make)
