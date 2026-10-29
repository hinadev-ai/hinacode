import { randomUUID } from "node:crypto"
import { Context, Effect, FileSystem, Layer, Option, type PlatformError, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { ForkPoint, ProviderId } from "../../shared/agent.ts"
import { UsageLimit } from "../../shared/limits.ts"
import {
  type AccessMode,
  type Changes,
  type ChangesScope,
  chatFolder,
  isThreadBusy,
  QueuedMessage,
  Thread,
  type ThreadStatus,
  type CheckoutTarget,
  type WorkspaceChoice,
} from "../../shared/domain.ts"
import { parseGitHubRepository } from "../../shared/github.ts"
import { nowIso } from "./clock.ts"
import {
  NotFoundError,
  type PersistenceError,
  persistence,
  PullRequestElsewhereError,
  type RootBusyError,
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
import { Scratch } from "./Scratch.ts"
import { diffWorkingTree, snapshotWorkingTree } from "./workingTree.ts"
import { Settings } from "./Settings.ts"
import { Terminals } from "./Terminals.ts"
import { makeActiveWorkspace } from "./workspace.ts"
import { Worktrees } from "./Worktrees.ts"

/** Enough for `@` completion in a large monorepo without sending the renderer a huge payload. */
const MAX_LISTED_FILES = 50_000

/** A placeholder title for a thread nobody has described yet. It doubles as its branch name. */
export const randomName = () => `thread-${randomUUID().slice(0, 5)}`

/** The thread table row. SQLite has no boolean, so `fast_mode` and `user_skills` are bits. */
const ThreadRow = Schema.Struct({
  ...Thread.fields,
  fastMode: Schema.BooleanFromBit,
  userSkills: Schema.BooleanFromBit,
  usageLimit: Schema.NullOr(Schema.fromJsonString(UsageLimit)),
  forkedFrom: Schema.NullOr(Schema.fromJsonString(ForkPoint)),
  queue: Schema.fromJsonString(Schema.Array(QueuedMessage)),
})

export interface CreateThread {
  readonly projectId: string
  readonly title: string
  readonly provider: ProviderId
  readonly model: string
  /** Null, the default, is the model's own effort. */
  readonly effort?: string | null | undefined
  readonly fastMode?: boolean | undefined
  /** Creates a worktree for the thread first; the thread points at it while its setup script runs. */
  readonly worktree?: { readonly branch: string; readonly baseRef: string } | undefined
  /** Defaults to `user`. */
  readonly createdBy?: string | undefined
}

export interface UpdateThread {
  readonly id: string
  readonly title?: string | undefined
  /**
   * Moves the thread to the new agent's default account unless `accountId` is given, and drops the session.
   * A started thread must go through `AgentRunner.switchAgent`, which marks the switch in the transcript.
   */
  readonly provider?: ProviderId | undefined
  /** Sets the account only. A started session must be copied to the new home first, as `AgentRunner.switchAccount` does. */
  readonly accountId?: string | null | undefined
  readonly model?: string | undefined
  /** Null goes back to the model's default effort. */
  readonly effort?: string | null | undefined
  readonly fastMode?: boolean | undefined
  readonly userSkills?: boolean | undefined
  readonly accessMode?: AccessMode | undefined
  readonly status?: ThreadStatus | undefined
  readonly usageLimit?: UsageLimit | null | undefined
  readonly sortIndex?: number | undefined
  readonly pinned?: boolean | undefined
  /** Null wakes the thread. */
  readonly snoozedUntil?: string | null | undefined
  readonly providerSessionId?: string | undefined
  readonly queue?: ReadonlyArray<QueuedMessage> | undefined
}

const arranging = new Set(["id", "sortIndex", "pinned", "snoozedUntil"])

// Arranging the sidebar is not activity, so it must not make a thread look fresh. Activity wakes a snoozed thread.
const onlyArranges = (input: UpdateThread) =>
  Object.entries(input).every(([key, value]) => arranging.has(key) || value === undefined)

export class Threads extends Context.Service<
  Threads,
  {
    readonly list: Effect.Effect<ReadonlyArray<Thread>, PersistenceError>
    readonly get: (id: string) => Effect.Effect<Thread, PersistenceError | NotFoundError>
    readonly create: (
      input: CreateThread,
    ) => Effect.Effect<Thread, PersistenceError | NotFoundError | CommandError | WorktreeTakenError>
    readonly update: (input: UpdateThread) => Effect.Effect<Thread, PersistenceError | NotFoundError>
    /**
     * A new thread in the same workspace that goes on from the turn `messageId` ended. It copies the transcript
     * up to that message, and its first turn forks the agent session there.
     */
    readonly fork: (threadId: string, messageId: string) => Effect.Effect<Thread, PersistenceError | NotFoundError>
    /** Files in the thread's working directory that git tracks or would track, for `@` mentions. */
    readonly listFiles: (
      id: string,
    ) => Effect.Effect<ReadonlyArray<string>, PersistenceError | NotFoundError | CommandError>
    /** Whether the thread has any message yet. */
    readonly started: (id: string) => Effect.Effect<boolean, PersistenceError>
    /**
     * Sets up where a thread that has not started runs. `local` switches the project root to the target.
     * `worktree` moves the thread into a new worktree: a `branch` target forks a branch named after the
     * thread's title from `ref`, or from the project's current branch when it is empty. A `pullRequest`
     * target checks out that pull request, and `pullRequestUrl` names it so it can be linked.
     */
    readonly prepareWorkspace: (
      id: string,
      choice: WorkspaceChoice,
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
      | RootBusyError
    >
    /**
     * Marks the thread archived and ends its terminals. With `Settings.archive.removeWorktree` on, it first
     * removes the thread's worktree, deleting the branch only if it is merged. A chat's folder and the thread's
     * scratch folder are deleted. Refuses while a turn runs.
     */
    readonly archive: (
      id: string,
    ) => Effect.Effect<Thread, PersistenceError | NotFoundError | CommandError | WorktreeBusyError | ThreadBusyError>
    /** Makes a chat's folder again, empty. */
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
    readonly captureTurnBase: (cwd: string) => Effect.Effect<string | null>
    readonly recordTurnBase: (input: {
      readonly threadId: string
      readonly tree: string | null
    }) => Effect.Effect<void, PersistenceError>
    /** Turns do not survive a restart, so threads left mid-turn by a crash go back to idle. */
    readonly resetInterrupted: Effect.Effect<void, PersistenceError>
  }
>()("hinacode/Threads") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const projects = yield* Projects
  const worktrees = yield* Worktrees
  const git = yield* Git
  const github = yield* GitHub
  const settings = yield* Settings
  const accounts = yield* AgentAccounts
  const terminals = yield* Terminals
  const scratch = yield* Scratch
  const activeWorkspace = yield* makeActiveWorkspace
  const gitContext = yield* Effect.context<Git | FileSystem.FileSystem>()
  const fs = yield* FileSystem.FileSystem

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

  const findForkPoint = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: Schema.String, messageId: Schema.String }),
    Result: Schema.Struct({ forkPoint: Schema.fromJsonString(ForkPoint) }),
    execute: ({ threadId, messageId }) =>
      sql`SELECT fork_point FROM message WHERE id = ${messageId} AND thread_id = ${threadId} AND fork_point IS NOT NULL`,
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

  /** Makes or removes a chat's own folder, and does nothing for a thread in a folder project. */
  const syncChatFolder = (thread: Thread, exists: boolean) =>
    Effect.gen(function* () {
      const project = yield* projects.get(thread.projectId)
      if (project.kind !== "chats") return
      const folder = chatFolder(project.rootPath, thread.id)
      yield* (
        exists ? fs.makeDirectory(folder, { recursive: true }) : fs.remove(folder, { recursive: true, force: true })
      ).pipe(Effect.mapError(persistence("threads.chatFolder")))
    })

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

  const create = ({
    worktree: worktreeInput,
    createdBy = "user",
    effort = null,
    fastMode = false,
    ...input
  }: CreateThread) =>
    Effect.gen(function* () {
      const project = yield* projects.get(input.projectId)
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
        effort,
        fastMode,
        userSkills: project.kind === "folder",
        accessMode: defaultAccessMode,
        accountId: defaultAccount[input.provider],
        providerSessionId: null,
        forkedFrom: null,
        status: "idle",
        usageLimit: null,
        sortIndex: next,
        pinnedAt: null,
        snoozedUntil: null,
        queue: [],
        createdBy,
        createdAt: now,
        updatedAt: now,
      }
      const row = yield* encodeRow(thread).pipe(Effect.mapError(persistence("threads.create")))
      yield* sql`INSERT INTO thread ${sql.insert(row)}`.pipe(Effect.mapError(persistence("threads.create")))
      yield* syncChatFolder(thread, true)
      return thread
    })

  const fork = (threadId: string, messageId: string) =>
    Effect.gen(function* () {
      const source = yield* get(threadId)
      const found = yield* findForkPoint({ threadId, messageId }).pipe(Effect.mapError(persistence("threads.fork")))
      if (Option.isNone(found)) return yield* new NotFoundError({ entity: "fork point", id: messageId })
      const { owner, ...forkedFrom } = found.value.forkPoint
      const { provider, accountId } = owner ?? source
      if (provider !== source.provider) return yield* new NotFoundError({ entity: "fork point", id: messageId })
      if (accountId !== null) yield* accounts.get(accountId)
      const { next } = yield* nextSortIndex(source.projectId).pipe(Effect.mapError(persistence("threads.fork")))
      const now = yield* nowIso
      const thread: Thread = {
        ...source,
        id: randomUUID(),
        title: `${source.title} (fork)`,
        accountId,
        providerSessionId: null,
        forkedFrom,
        status: "idle",
        usageLimit: null,
        sortIndex: next,
        pinnedAt: null,
        snoozedUntil: null,
        queue: [],
        createdBy: "user",
        createdAt: now,
        updatedAt: now,
      }
      const row = yield* encodeRow(thread).pipe(Effect.mapError(persistence("threads.fork")))
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO thread ${sql.insert(row)}`
            yield* sql`
            INSERT INTO message (id, thread_id, role, parts, created_at, completed_at, usage, fork_point)
            SELECT lower(hex(randomblob(16))), ${thread.id}, role, parts, created_at, completed_at, usage, fork_point
            FROM message
            WHERE thread_id = ${threadId}
              AND (created_at, rowid) <= (SELECT created_at, rowid FROM message WHERE id = ${messageId})
            ORDER BY created_at, rowid
          `
          }),
        )
        .pipe(Effect.mapError(persistence("threads.fork")))
      yield* syncChatFolder(thread, true)
      return thread
    })

  const update = (input: UpdateThread) =>
    Effect.gen(function* () {
      const current = yield* get(input.id)
      const switchesAgent = input.provider !== undefined && input.provider !== current.provider
      const provider = input.provider ?? current.provider
      const accountId =
        input.accountId !== undefined
          ? input.accountId
          : switchesAgent
            ? (yield* settings.get).defaultAccount[provider]
            : current.accountId
      // An account of another agent is as unknown to this thread as a missing one.
      if (
        accountId !== current.accountId &&
        accountId !== null &&
        (yield* accounts.get(accountId)).provider !== provider
      ) {
        return yield* new NotFoundError({ entity: "account", id: accountId })
      }
      return yield* write(current, {
        ...input,
        accountId: accountId === current.accountId ? undefined : accountId,
        // The usage limit belonged to the agent the thread leaves.
        ...(switchesAgent && current.status === "limited" && { status: "idle" }),
      })
    })

  const write = (current: Thread, input: UpdateThread) =>
    Effect.gen(function* () {
      const now = yield* nowIso
      const arranges = onlyArranges(input)
      const next: Thread = {
        ...current,
        title: input.title ?? current.title,
        provider: input.provider ?? current.provider,
        accountId: input.accountId === undefined ? current.accountId : input.accountId,
        model: input.model ?? current.model,
        effort: input.effort === undefined ? current.effort : input.effort,
        fastMode: input.fastMode ?? current.fastMode,
        userSkills: input.userSkills ?? current.userSkills,
        accessMode: input.accessMode ?? current.accessMode,
        status: input.status ?? current.status,
        usageLimit:
          input.status !== undefined && input.status !== "limited"
            ? null
            : input.usageLimit === undefined
              ? current.usageLimit
              : input.usageLimit,
        sortIndex: input.sortIndex ?? current.sortIndex,
        pinnedAt: input.pinned === undefined ? current.pinnedAt : input.pinned ? (current.pinnedAt ?? now) : null,
        snoozedUntil: input.snoozedUntil !== undefined ? input.snoozedUntil : arranges ? current.snoozedUntil : null,
        // A session id belongs to one agent.
        providerSessionId:
          input.provider !== undefined && input.provider !== current.provider
            ? null
            : (input.providerSessionId ?? current.providerSessionId),
        forkedFrom:
          input.providerSessionId !== undefined || (input.provider ?? current.provider) !== current.provider
            ? null
            : current.forkedFrom,
        queue: input.queue ?? current.queue,
        updatedAt: arranges ? current.updatedAt : now,
      }
      yield* sql`
        UPDATE thread
        SET title = ${next.title}, provider = ${next.provider}, account_id = ${next.accountId}, model = ${next.model},
            effort = ${next.effort}, fast_mode = ${next.fastMode ? 1 : 0}, user_skills = ${next.userSkills ? 1 : 0},
            access_mode = ${next.accessMode}, status = ${next.status},
            sort_index = ${next.sortIndex}, pinned_at = ${next.pinnedAt}, snoozed_until = ${next.snoozedUntil},
            provider_session_id = ${next.providerSessionId},
            forked_from = ${next.forkedFrom === null ? null : JSON.stringify(next.forkedFrom)},
            updated_at = ${next.updatedAt}, usage_limit = ${next.usageLimit === null ? null : JSON.stringify(next.usageLimit)},
            queue = ${JSON.stringify(next.queue)}
        WHERE id = ${next.id}
      `.pipe(Effect.mapError(persistence("threads.update")))
      return next
    })

  const resolvePullRequest = (projectId: string, selector: string) =>
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
      return head
    })

  const checkoutRoot = (thread: Thread, target: CheckoutTarget) =>
    Effect.gen(function* () {
      if (target._tag === "pullRequest") {
        const head = yield* resolvePullRequest(thread.projectId, target.selector)
        yield* worktrees.checkoutPullRequest(thread.projectId, head, thread.id)
        return { thread, pullRequestUrl: head.url }
      }
      const ref = target.ref.trim()
      if (ref !== "" && ref !== (yield* worktrees.currentBranch(thread.projectId))) {
        yield* worktrees.checkout(thread.projectId, ref, thread.id)
      }
      return { thread, pullRequestUrl: null }
    })

  const pullRequestWorktree = (projectId: string, selector: string) =>
    Effect.gen(function* () {
      const head = yield* resolvePullRequest(projectId, selector)
      return { worktree: yield* worktrees.createFromPullRequest(projectId, head), pullRequestUrl: head.url }
    })

  const attachWorktree = (thread: Thread, target: CheckoutTarget) =>
    Effect.gen(function* () {
      const { worktree, pullRequestUrl } =
        target._tag === "pullRequest"
          ? yield* pullRequestWorktree(thread.projectId, target.selector)
          : {
              worktree: yield* worktrees.create({
                projectId: thread.projectId,
                branch: `kk/${slugifyBranch(thread.title) || randomName()}`,
                baseRef: target.ref.trim() || (yield* worktrees.currentBranch(thread.projectId)),
              }),
              pullRequestUrl: null,
            }
      const updatedAt = yield* nowIso
      yield* sql`UPDATE thread SET worktree_id = ${worktree.id}, updated_at = ${updatedAt} WHERE id = ${thread.id}`.pipe(
        Effect.mapError(persistence("threads.attachWorktree")),
      )
      return { thread: { ...thread, worktreeId: worktree.id, updatedAt }, pullRequestUrl }
    })

  const prepareWorkspace = (id: string, { mode, target }: WorkspaceChoice) =>
    Effect.gen(function* () {
      const thread = yield* get(id)
      if (thread.worktreeId !== null || (yield* started(id))) return yield* new ThreadStartedError({ id })
      return yield* mode === "local" ? checkoutRoot(thread, target) : attachWorktree(thread, target)
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

  const captureTurnBase = (cwd: string) =>
    snapshotWorkingTree(cwd).pipe(
      Effect.provideContext(gitContext),
      Effect.orElseSucceed(() => null),
    )

  const recordTurnBase: typeof Threads.Service.recordTurnBase = ({ threadId, tree }) =>
    sql`UPDATE thread SET turn_base_tree = ${tree} WHERE id = ${threadId}`.pipe(
      Effect.mapError(persistence("threads.recordTurnBase")),
      Effect.asVoid,
    )

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
        yield* syncChatFolder(thread, false)
        yield* scratch.remove(id)
        return yield* get(id)
      }),
    )

  const unarchive = (id: string) =>
    Effect.gen(function* () {
      const thread = yield* get(id)
      yield* syncChatFolder(thread, true)
      return yield* write(thread, { id, status: "idle" })
    })

  const remove = (id: string, options?: { readonly removeWorktree?: boolean | undefined }) =>
    Effect.gen(function* () {
      const thread = yield* get(id)
      if (options?.removeWorktree) yield* removeOwnWorktree(thread)
      yield* sql`DELETE FROM thread WHERE id = ${id}`.pipe(Effect.mapError(persistence("threads.delete")))
      yield* syncChatFolder(thread, false)
      yield* scratch.remove(id)
    })

  return Threads.of({
    list: findAll(undefined).pipe(Effect.mapError(persistence("threads.list"))),
    get,
    create,
    update,
    fork,
    started,
    prepareWorkspace,
    listFiles,
    changes,
    captureTurnBase,
    recordTurnBase,
    archive,
    unarchive,
    remove,
    resetInterrupted: sql`
      UPDATE thread SET status = 'idle' WHERE status IN ('running', 'awaiting_approval')
    `.pipe(Effect.asVoid, Effect.mapError(persistence("threads.resetInterrupted"))),
  })
})

export const layer = Layer.effect(Threads, make)
