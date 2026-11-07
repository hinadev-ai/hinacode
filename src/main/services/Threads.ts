import { randomUUID } from "node:crypto"
import { join } from "node:path"
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  type PlatformError,
  PubSub,
  Schema,
  type Scope,
  Semaphore,
  Stream,
} from "effect"
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
  ScheduledMessage,
  Thread,
  type ThreadStatus,
  type CheckoutTarget,
  type WorkspaceChoice,
} from "../../shared/domain.ts"
import { parseGitHubRepository } from "../../shared/github.ts"
import { nowIso } from "./clock.ts"
import {
  type FolderMissingError,
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
import { Events } from "./Events.ts"
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

const MAX_LISTED_FILES = 50_000

export const randomName = () => `thread-${randomUUID().slice(0, 5)}`

const ThreadRow = Schema.Struct({
  ...Thread.fields,
  fastMode: Schema.BooleanFromBit,
  usageLimit: Schema.NullOr(Schema.fromJsonString(UsageLimit)),
  forkedFrom: Schema.NullOr(Schema.fromJsonString(ForkPoint)),
  queue: Schema.fromJsonString(Schema.Array(QueuedMessage)),
  scheduled: Schema.fromJsonString(Schema.Array(ScheduledMessage)),
})

export interface CreateThread {
  readonly projectId: string
  readonly title: string
  readonly provider: ProviderId
  readonly model: string
  readonly effort?: string | null | undefined
  readonly fastMode?: boolean | undefined
  readonly worktree?: { readonly branch: string; readonly baseRef: string } | undefined
  readonly createdBy?: string | undefined
  readonly parentId?: string | undefined
}

export type DraftThread = Omit<CreateThread, "worktree" | "createdBy" | "parentId">

export interface UpdateThread {
  readonly id: string
  readonly title?: string | undefined
  readonly provider?: ProviderId | undefined
  readonly accountId?: string | null | undefined
  readonly model?: string | undefined
  readonly effort?: string | null | undefined
  readonly fastMode?: boolean | undefined
  readonly accessMode?: AccessMode | undefined
  readonly status?: ThreadStatus | undefined
  readonly usageLimit?: UsageLimit | null | undefined
  readonly sortIndex?: number | undefined
  readonly pinned?: boolean | undefined
  readonly snoozedUntil?: string | null | undefined
  readonly settled?: boolean | undefined
  readonly providerSessionId?: string | undefined
  readonly queue?: ReadonlyArray<QueuedMessage> | undefined
  readonly scheduled?: ReadonlyArray<ScheduledMessage> | undefined
}

const arranging = new Set([
  "id",
  "sortIndex",
  "pinned",
  "snoozedUntil",
  "settled",
  "provider",
  "accountId",
  "model",
  "effort",
  "fastMode",
  "accessMode",
])

const startsWork = (from: ThreadStatus, to: ThreadStatus) =>
  ((from === "idle" || from === "limited") && to === "running") || (from === "archived" && to !== "archived")

const onlyArranges = (input: UpdateThread) =>
  Object.entries(input).every(([key, value]) => arranging.has(key) || value === undefined)

export class Threads extends Context.Service<
  Threads,
  {
    readonly list: Effect.Effect<ReadonlyArray<Thread>, PersistenceError>
    readonly onAccount: (accountId: string) => Effect.Effect<ReadonlyArray<Thread>, PersistenceError>
    readonly get: (id: string) => Effect.Effect<Thread, PersistenceError | NotFoundError>
    readonly create: (
      input: CreateThread,
    ) => Effect.Effect<Thread, PersistenceError | NotFoundError | CommandError | WorktreeTakenError>
    readonly update: (input: UpdateThread) => Effect.Effect<Thread, PersistenceError | NotFoundError>
    readonly writes: Effect.Effect<Stream.Stream<Thread>, never, Scope.Scope>
    readonly fork: (
      threadId: string,
      messageId?: string,
    ) => Effect.Effect<
      Thread,
      PersistenceError | NotFoundError | CommandError | WorktreeTakenError | PlatformError.PlatformError
    >
    readonly sidechat: (threadId: string) => Effect.Effect<Thread, PersistenceError | NotFoundError>
    readonly sidechatOf: (threadId: string) => Effect.Effect<Option.Option<Thread>, PersistenceError>
    readonly rebaseSidechat: (
      id: string,
      parent: Thread,
      forkPoint: ForkPoint | null,
    ) => Effect.Effect<Thread, PersistenceError | NotFoundError>
    readonly listFiles: (
      id: string,
    ) => Effect.Effect<ReadonlyArray<string>, PersistenceError | NotFoundError | FolderMissingError | CommandError>
    readonly started: (id: string) => Effect.Effect<boolean, PersistenceError>
    readonly draft: (
      input: DraftThread,
    ) => Effect.Effect<Thread, PersistenceError | NotFoundError | CommandError | WorktreeTakenError>
    readonly promoteDraft: (id: string) => Effect.Effect<Thread, PersistenceError | NotFoundError>
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
    readonly archive: (
      id: string,
    ) => Effect.Effect<Thread, PersistenceError | NotFoundError | CommandError | WorktreeBusyError | ThreadBusyError>
    readonly unarchive: (id: string) => Effect.Effect<Thread, PersistenceError | NotFoundError>
    readonly settle: (id: string) => Effect.Effect<Thread, PersistenceError | NotFoundError | ThreadBusyError>
    readonly settleMerged: (
      id: string,
      stillDue: (thread: Thread, workStartedAt: string | null) => boolean,
    ) => Effect.Effect<Option.Option<Thread>, PersistenceError | NotFoundError | CommandError | WorktreeBusyError>
    readonly unsettle: (id: string) => Effect.Effect<Thread, PersistenceError | NotFoundError>
    readonly workStartedAt: (id: string) => Effect.Effect<string | null, PersistenceError>
    readonly remove: (
      id: string,
      options?: { readonly removeWorktree?: boolean | undefined },
    ) => Effect.Effect<void, PersistenceError | NotFoundError | CommandError | WorktreeBusyError>
    readonly changes: (
      id: string,
      scope: ChangesScope,
    ) => Effect.Effect<
      Changes | null,
      PersistenceError | NotFoundError | FolderMissingError | CommandError | PlatformError.PlatformError
    >
    readonly undoTurn: (
      id: string,
    ) => Effect.Effect<
      void,
      | PersistenceError
      | NotFoundError
      | FolderMissingError
      | CommandError
      | PlatformError.PlatformError
      | ThreadBusyError
    >
    readonly captureTurnBase: (cwd: string) => Effect.Effect<string | null>
    readonly recordTurnBase: (input: {
      readonly threadId: string
      readonly tree: string | null
    }) => Effect.Effect<void, PersistenceError>
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
  const events = yield* Events
  const activeWorkspace = yield* makeActiveWorkspace
  const gitContext = yield* Effect.context<Git | FileSystem.FileSystem>()
  const fs = yield* FileSystem.FileSystem

  const encodeRow = Schema.encodeEffect(ThreadRow)
  const written = yield* PubSub.unbounded<Thread>()

  const findAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ThreadRow,
    execute: () =>
      sql`SELECT * FROM thread WHERE side_of IS NULL AND ${sql.in("provider", [...ProviderId.literals])} ORDER BY project_id, sort_index`,
  })
  const findOnAccount = SqlSchema.findAll({
    Request: Schema.String,
    Result: ThreadRow,
    execute: (accountId) => sql`SELECT * FROM thread WHERE account_id = ${accountId}`,
  })
  const findById = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ThreadRow,
    execute: (id) => sql`SELECT * FROM thread WHERE id = ${id}`,
  })
  const findDraft = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ThreadRow,
    execute: (projectId) =>
      sql`SELECT * FROM thread WHERE project_id = ${projectId} AND status = 'draft' AND created_by = 'user' ORDER BY created_at DESC LIMIT 1`,
  })
  const findSidechat = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ThreadRow,
    execute: (parentId) => sql`SELECT * FROM thread WHERE side_of = ${parentId}`,
  })
  const detachChildRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: ThreadRow,
    execute: (parentId) => sql`UPDATE thread SET parent_id = NULL WHERE parent_id = ${parentId} RETURNING *`,
  })
  const nextSortIndex = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ next: Schema.Number }),
    execute: (projectId) =>
      sql`SELECT COALESCE(MAX(sort_index) + 1, 0) AS next FROM thread WHERE project_id = ${projectId}`,
  })

  const findForkPoints = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: Schema.String, messageId: Schema.NullOr(Schema.String) }),
    Result: Schema.Struct({ id: Schema.String, forkPoint: Schema.fromJsonString(ForkPoint) }),
    execute: ({ threadId, messageId }) => sql`
      SELECT id, fork_point FROM message
      WHERE thread_id = ${threadId} AND fork_point IS NOT NULL AND (${messageId} IS NULL OR id = ${messageId})
      ORDER BY created_at DESC, rowid DESC
    `,
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

  const insertThread = (
    { worktree: worktreeInput, createdBy = "user", effort = null, fastMode = false, parentId, ...input }: CreateThread,
    status: "draft" | "idle",
  ) =>
    Effect.gen(function* () {
      yield* projects.get(input.projectId)
      const parent = parentId === undefined ? undefined : yield* get(parentId)
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
        accessMode: defaultAccessMode,
        accountId: defaultAccount[input.provider],
        providerSessionId: null,
        forkedFrom: null,
        sideOf: null,
        parentId: parent === undefined ? null : (parent.parentId ?? parent.id),
        status,
        usageLimit: null,
        sortIndex: next,
        pinnedAt: null,
        snoozedUntil: null,
        settledAt: null,
        queue: [],
        scheduled: [],
        createdBy,
        createdAt: now,
        updatedAt: now,
      }
      const row = yield* encodeRow(thread).pipe(Effect.mapError(persistence("threads.create")))
      yield* sql`INSERT INTO thread ${sql.insert(row)}`.pipe(Effect.mapError(persistence("threads.create")))
      yield* syncChatFolder(thread, true)
      return thread
    })

  const create = (input: CreateThread) => insertThread(input, "idle")

  const drafting = Semaphore.makeUnsafe(1)

  const draft = (input: DraftThread) =>
    Effect.gen(function* () {
      const existing = yield* findDraft(input.projectId).pipe(Effect.mapError(persistence("threads.draft")))
      if (Option.isNone(existing)) return yield* insertThread({ ...input, createdBy: "user" }, "draft")
      const { defaultAccessMode, defaultAccount } = yield* settings.get
      return yield* write(existing.value, {
        id: existing.value.id,
        provider: input.provider,
        model: input.model,
        effort: input.effort ?? null,
        fastMode: input.fastMode ?? false,
        accessMode: defaultAccessMode,
        accountId: defaultAccount[input.provider],
      })
    }).pipe(drafting.withPermits(1))

  const promoteDraft = (id: string) =>
    Effect.gen(function* () {
      const thread = yield* get(id)
      if (thread.status !== "draft") return thread
      const { next } = yield* nextSortIndex(thread.projectId).pipe(Effect.mapError(persistence("threads.promoteDraft")))
      const now = yield* nowIso
      yield* sql`
        UPDATE thread SET status = 'idle', sort_index = ${next}, created_at = ${now}, updated_at = ${now}
        WHERE id = ${thread.id}
      `.pipe(Effect.mapError(persistence("threads.promoteDraft")))
      return { ...thread, status: "idle" as const, sortIndex: next, createdAt: now, updatedAt: now }
    }).pipe(drafting.withPermits(1))

  const forkWorktree = (source: Thread) =>
    Effect.gen(function* () {
      if (source.worktreeId === null) return null
      const worktree = yield* worktrees.get(source.worktreeId)
      if (worktree.status === "removed") return worktree.id
      const workingTree = yield* snapshotWorkingTree(worktree.path).pipe(Effect.provideContext(gitContext))
      const forked = yield* worktrees.create({
        projectId: source.projectId,
        branch: `${worktree.branch}-fork-${randomUUID().slice(0, 5)}`,
        baseRef: worktree.baseRef,
        startPoint: worktree.branch,
        workingTree,
      })
      return forked.id
    })

  const fork = (threadId: string, messageId?: string) =>
    Effect.gen(function* () {
      const source = yield* get(threadId)
      const points = yield* findForkPoints({ threadId, messageId: messageId ?? null }).pipe(
        Effect.mapError(persistence("threads.fork")),
      )
      const found = points.find((point) => (point.forkPoint.owner?.provider ?? source.provider) === source.provider)
      if (found === undefined) return yield* new NotFoundError({ entity: "fork point", id: messageId ?? threadId })
      const { owner, ...forkedFrom } = found.forkPoint
      const { accountId } = owner ?? source
      if (accountId !== null) yield* accounts.get(accountId)
      const { next } = yield* nextSortIndex(source.projectId).pipe(Effect.mapError(persistence("threads.fork")))
      const worktreeId = yield* forkWorktree(source)
      const now = yield* nowIso
      const thread: Thread = {
        ...source,
        id: randomUUID(),
        title: `${source.title} (fork)`,
        worktreeId,
        accountId,
        providerSessionId: null,
        forkedFrom,
        sideOf: null,
        parentId: null,
        status: "idle",
        usageLimit: null,
        sortIndex: next,
        pinnedAt: null,
        snoozedUntil: null,
        settledAt: null,
        queue: [],
        scheduled: [],
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
              AND (created_at, rowid) <= (SELECT created_at, rowid FROM message WHERE id = ${found.id})
            ORDER BY created_at, rowid
          `
          }),
        )
        .pipe(Effect.mapError(persistence("threads.fork")))
      yield* syncChatFolder(thread, true)
      return thread
    })

  const sidechat = (parentId: string) =>
    Effect.gen(function* () {
      const existing = yield* findSidechat(parentId).pipe(Effect.mapError(persistence("threads.sidechat")))
      if (Option.isSome(existing)) return existing.value
      const parent = yield* get(parentId)
      const now = yield* nowIso
      const thread: Thread = {
        ...parent,
        id: randomUUID(),
        accessMode: "supervised",
        providerSessionId: null,
        forkedFrom: null,
        sideOf: parent.id,
        parentId: null,
        status: "idle",
        usageLimit: null,
        pinnedAt: null,
        snoozedUntil: null,
        settledAt: null,
        queue: [],
        scheduled: [],
        createdBy: "user",
        createdAt: now,
        updatedAt: now,
      }
      const row = yield* encodeRow(thread).pipe(Effect.mapError(persistence("threads.sidechat")))
      yield* sql`INSERT INTO thread ${sql.insert(row)} ON CONFLICT (side_of) DO NOTHING`.pipe(
        Effect.mapError(persistence("threads.sidechat")),
      )
      const created = yield* findSidechat(parentId).pipe(Effect.mapError(persistence("threads.sidechat")))
      return Option.getOrElse(created, () => thread)
    })

  const rebaseSidechat = (id: string, parent: Thread, forkPoint: ForkPoint | null) =>
    Effect.gen(function* () {
      const current = yield* get(id)
      const next: Thread = {
        ...current,
        ...(current.provider !== parent.provider && {
          provider: parent.provider,
          model: parent.model,
          effort: parent.effort,
          fastMode: parent.fastMode,
        }),
        worktreeId: parent.worktreeId,
        accountId: forkPoint?.owner?.accountId ?? parent.accountId,
        forkedFrom: forkPoint === null ? null : { sessionId: forkPoint.sessionId, checkpoint: forkPoint.checkpoint },
        updatedAt: yield* nowIso,
      }
      yield* sql`
        UPDATE thread
        SET worktree_id = ${next.worktreeId}, provider = ${next.provider}, model = ${next.model}, effort = ${next.effort},
            fast_mode = ${next.fastMode ? 1 : 0}, account_id = ${next.accountId},
            forked_from = ${next.forkedFrom === null ? null : JSON.stringify(next.forkedFrom)}, updated_at = ${next.updatedAt}
        WHERE id = ${id}
      `.pipe(Effect.mapError(persistence("threads.rebaseSidechat")))
      return next
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
        ...(switchesAgent && current.status === "limited" && { status: "idle" }),
      })
    })

  const write = (current: Thread, input: UpdateThread) =>
    Effect.gen(function* () {
      const now = yield* nowIso
      const arranges = onlyArranges(input)
      const settling = input.settled === true
      const reopening = input.settled === false
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
        pinnedAt: settling
          ? null
          : input.pinned === undefined
            ? current.pinnedAt
            : input.pinned
              ? (current.pinnedAt ?? now)
              : null,
        snoozedUntil: settling
          ? null
          : input.snoozedUntil !== undefined
            ? input.snoozedUntil
            : arranges
              ? current.snoozedUntil
              : null,
        settledAt: settling
          ? now
          : reopening ||
              input.pinned === true ||
              (input.status !== undefined && startsWork(current.status, input.status))
            ? null
            : current.settledAt,
        providerSessionId:
          input.provider !== undefined && input.provider !== current.provider
            ? null
            : (input.providerSessionId ?? current.providerSessionId),
        forkedFrom:
          input.providerSessionId !== undefined || (input.provider ?? current.provider) !== current.provider
            ? null
            : current.forkedFrom,
        queue: input.queue ?? current.queue,
        scheduled: input.scheduled ?? current.scheduled,
        updatedAt: arranges && !reopening ? current.updatedAt : now,
      }
      yield* sql`
        UPDATE thread
        SET title = ${next.title}, provider = ${next.provider}, account_id = ${next.accountId}, model = ${next.model},
            effort = ${next.effort}, fast_mode = ${next.fastMode ? 1 : 0},
            access_mode = ${next.accessMode}, status = ${next.status},
            sort_index = ${next.sortIndex}, pinned_at = ${next.pinnedAt}, snoozed_until = ${next.snoozedUntil}, settled_at = ${next.settledAt},
            provider_session_id = ${next.providerSessionId},
            forked_from = ${next.forkedFrom === null ? null : JSON.stringify(next.forkedFrom)},
            updated_at = ${next.updatedAt}, usage_limit = ${next.usageLimit === null ? null : JSON.stringify(next.usageLimit)},
            queue = ${JSON.stringify(next.queue)}, scheduled = ${JSON.stringify(next.scheduled)}
        WHERE id = ${next.id}
      `.pipe(Effect.mapError(persistence("threads.update")))
      if (startsWork(current.status, next.status) || reopening) {
        yield* sql`UPDATE thread SET work_started_at = ${now} WHERE id = ${next.id}`.pipe(
          Effect.mapError(persistence("threads.update")),
        )
      }
      yield* PubSub.publish(written, next)
      return next
    })

  const resolvePullRequest = (projectId: string, selector: string) =>
    Effect.gen(function* () {
      const { rootPath } = yield* projects.get(projectId)
      const head = yield* github.pullRequestHead(rootPath, selector)
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
      const base = yield* turnBase(id)
      return base === null ? null : yield* turnChanges(base)
    })

  const turnBase = (id: string) =>
    Effect.gen(function* () {
      const row = yield* findTurnBase(id).pipe(Effect.mapError(persistence("threads.turnBase")))
      if (Option.isNone(row)) return yield* new NotFoundError({ entity: "thread", id })
      const { turnBaseTree } = row.value
      if (turnBaseTree === null) return null
      const { cwd } = yield* activeWorkspace(id)
      return { tree: turnBaseTree, cwd }
    })

  const turnChanges = ({ tree, cwd }: { tree: string; cwd: string }) =>
    diffWorkingTree(cwd, Effect.succeed(tree)).pipe(Effect.provideContext(gitContext))

  const undoTurn = (id: string) =>
    Effect.gen(function* () {
      const thread = yield* get(id)
      if (isThreadBusy(thread.status)) return yield* new ThreadBusyError({ id })
      const base = yield* turnBase(id)
      if (base === null) return
      const { files } = yield* turnChanges(base)
      const root = (yield* git.run(base.cwd, ["rev-parse", "--show-toplevel"])).trim()
      yield* Effect.forEach(
        files.filter((file) => file.status === "added"),
        (file) => fs.remove(join(root, file.path), { force: true }),
        { discard: true },
      )
      const restored = files.filter((file) => file.status !== "added").map((file) => file.path)
      if (restored.length > 0) {
        yield* git.run(root, ["restore", `--source=${base.tree}`, "--worktree", "--", ...restored], {
          env: { GIT_LITERAL_PATHSPECS: "1" },
        })
      }
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

  const detachChildren = (parentId: string) =>
    Effect.gen(function* () {
      const detached = yield* detachChildRows(parentId).pipe(Effect.mapError(persistence("threads.archive")))
      yield* Effect.forEach(detached, (thread) => events.publish({ type: "thread.updated", thread }), {
        discard: true,
      })
    })

  const removeOwnWorktree = (thread: Thread) =>
    thread.worktreeId ? worktrees.remove(thread.worktreeId, "ifMerged", thread.id) : Effect.void

  const removeWorktreeIfSet = (thread: Thread) =>
    Effect.gen(function* () {
      if (!(yield* settings.get).archive.removeWorktree || !thread.worktreeId) return
      yield* worktrees.removeWhileExclusive(thread.worktreeId, "ifMerged", thread.id).pipe(
        Effect.catchIf(
          (error) => error._tag === "WorktreeBusyError" && error.reason === "shared",
          () => Effect.void,
        ),
      )
    })

  const archive = (id: string) =>
    worktrees.exclusive(
      Effect.gen(function* () {
        const thread = yield* get(id)
        if (isThreadBusy(thread.status)) return yield* new ThreadBusyError({ id })
        yield* removeWorktreeIfSet(thread)
        yield* terminals.closeThread(id)
        yield* sql`
          UPDATE thread SET status = 'archived', usage_limit = NULL, updated_at = ${yield* nowIso} WHERE id = ${id}
        `.pipe(Effect.mapError(persistence("threads.archive")))
        yield* detachChildren(id)
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

  const settle = (id: string) =>
    Effect.gen(function* () {
      const thread = yield* get(id)
      if (isThreadBusy(thread.status)) return yield* new ThreadBusyError({ id })
      if (thread.status === "archived") return thread
      return yield* write(thread, { id, settled: true })
    })

  const settleMerged = (id: string, stillDue: (thread: Thread, workStartedAt: string | null) => boolean) =>
    worktrees.exclusive(
      Effect.gen(function* () {
        const isDue = Effect.gen(function* () {
          const thread = yield* get(id)
          return stillDue(thread, yield* workStartedAt(id)) ? Option.some(thread) : Option.none()
        })
        const before = yield* isDue
        if (Option.isNone(before)) return Option.none<Thread>()
        yield* removeWorktreeIfSet(before.value)
        const after = yield* isDue
        if (Option.isNone(after)) return Option.none<Thread>()
        return Option.some(yield* write(after.value, { id, settled: true }))
      }),
    )

  const unsettle = (id: string) =>
    Effect.gen(function* () {
      return yield* write(yield* get(id), { id, settled: false })
    })

  const workStartedAt = (id: string) =>
    sql<{ readonly startedAt: string | null }>`SELECT work_started_at AS startedAt FROM thread WHERE id = ${id}`.pipe(
      Effect.map((rows) => rows[0]?.startedAt ?? null),
      Effect.mapError(persistence("threads.workStartedAt")),
    )

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
    onAccount: (accountId) => findOnAccount(accountId).pipe(Effect.mapError(persistence("threads.onAccount"))),
    get,
    create,
    update,
    writes: Effect.map(PubSub.subscribe(written), Stream.fromSubscription),
    fork,
    sidechat,
    sidechatOf: (parentId: string) => findSidechat(parentId).pipe(Effect.mapError(persistence("threads.sidechatOf"))),
    rebaseSidechat,
    started,
    draft,
    promoteDraft,
    prepareWorkspace,
    listFiles,
    changes,
    undoTurn,
    captureTurnBase,
    recordTurnBase,
    archive,
    unarchive,
    settle,
    settleMerged,
    unsettle,
    workStartedAt,
    remove,
    resetInterrupted: sql`
      UPDATE thread SET status = 'idle' WHERE status IN ('running', 'awaiting_approval')
    `.pipe(Effect.asVoid, Effect.mapError(persistence("threads.resetInterrupted"))),
  })
})

export const layer = Layer.effect(Threads, make)
