import { Clock, Context, Effect, Layer, Option, Schedule } from "effect"
import { isThreadBusy, type PullRequest, type PullRequestLink, type Thread } from "../../shared/domain.ts"
import { AgentRunner } from "./AgentRunner.ts"
import { ThreadBusyError, type NotFoundError, type PersistenceError } from "./errors.ts"
import { Events } from "./Events.ts"
import { GitHub } from "./GitHub.ts"
import { Ports } from "./Ports.ts"
import { PullRequests } from "./PullRequests.ts"
import { Settings } from "./Settings.ts"
import { Terminals } from "./Terminals.ts"
import { Threads } from "./Threads.ts"
import { forkPullRequestBranch, Worktrees } from "./Worktrees.ts"

const SWEEP_INTERVAL = "3 minutes"
const DAY_MS = 24 * 60 * 60 * 1000

export class Settle extends Context.Service<
  Settle,
  {
    readonly settle: (threadId: string) => Effect.Effect<Thread, PersistenceError | NotFoundError | ThreadBusyError>
    readonly sweep: Effect.Effect<void>
  }
>()("hinacode/Settle") {}

const isFinished = (pullRequest: PullRequest) => pullRequest.status === "merged" || pullRequest.status === "closed"

const mergedSince = (pullRequest: PullRequest, workStartedAt: string | null) =>
  pullRequest.status === "merged" &&
  (workStartedAt === null ||
    pullRequest.mergedAt === undefined ||
    pullRequest.mergedAt === null ||
    Date.parse(pullRequest.mergedAt) > Date.parse(workStartedAt))

const canAutoSettle = (thread: Thread) =>
  thread.status !== "archived" && !isThreadBusy(thread.status) && thread.settledAt === null && thread.pinnedAt === null

const lastActivity = (thread: Thread) =>
  thread.snoozedUntil !== null && thread.snoozedUntil > thread.updatedAt ? thread.snoozedUntil : thread.updatedAt

const olderThan = (timestamp: string, days: number, now: number) => now - Date.parse(timestamp) >= days * DAY_MS

const isIdleFor = (thread: Thread, days: number, now: number) =>
  canAutoSettle(thread) && thread.status === "idle" && olderThan(lastActivity(thread), days, now)

const isSettledFor = (thread: Thread, days: number, now: number) =>
  thread.status === "idle" &&
  thread.pinnedAt === null &&
  thread.settledAt !== null &&
  olderThan(thread.settledAt, days, now)

const isOpen = (pullRequest: PullRequest) => pullRequest.status === "open" || pullRequest.status === "draft"

const make = Effect.gen(function* () {
  const settings = yield* Settings
  const threads = yield* Threads
  const pullRequests = yield* PullRequests
  const github = yield* GitHub
  const events = yield* Events
  const worktrees = yield* Worktrees
  const runner = yield* AgentRunner
  const terminals = yield* Terminals
  const ports = yield* Ports

  const stopProcesses = (threadId: string) =>
    terminals.closeThread(threadId).pipe(Effect.andThen(ports.closeThread(threadId)))

  const hasAgentWork = (threadId: string) =>
    Effect.gen(function* () {
      const tasks = yield* runner.backgroundTasks(threadId)
      const subagents = yield* runner.subagents(threadId)
      return tasks.length > 0 || subagents.some((subagent) => subagent.status === "running")
    })

  const hasListeningPort = (threadId: string) =>
    ports.listForThread(threadId).pipe(
      Effect.map((open) => open.length > 0),
      Effect.catchTag("FolderMissingError", () => Effect.succeed(false)),
    )

  const settle = (threadId: string) =>
    Effect.gen(function* () {
      if (isThreadBusy((yield* threads.get(threadId)).status)) return yield* new ThreadBusyError({ id: threadId })
      const settled = yield* runner.release(
        threadId,
        stopProcesses(threadId).pipe(Effect.andThen(threads.settle(threadId))),
      )
      if (Option.isNone(settled)) return yield* new ThreadBusyError({ id: threadId })
      return settled.value
    })

  const ownBranch = (worktreeId: string | null) =>
    Effect.gen(function* () {
      if (worktreeId === null) return null
      const worktree = yield* worktrees.get(worktreeId)
      return worktree.status === "removed" ? null : worktree.branch
    })

  const settleIfDone = (threadId: string, links: ReadonlyArray<PullRequestLink>) =>
    Effect.gen(function* () {
      const thread = yield* threads.get(threadId)
      if (!canAutoSettle(thread) || (yield* hasAgentWork(threadId))) return
      const branch = yield* ownBranch(thread.worktreeId)
      const found = yield* Effect.forEach(links, (link) => github.pullRequest(link.url), { concurrency: 4 })
      const isOwn = (pullRequest: PullRequest) =>
        branch === null || branch === pullRequest.headRefName || branch === forkPullRequestBranch(pullRequest.number)
      const allFinished = found.every(
        (pullRequest, index) => isFinished(pullRequest) || (!isOwn(pullRequest) && links[index]!.watch === null),
      )
      if (!allFinished || (yield* hasListeningPort(threadId))) return
      const ownMergedSince = (workStartedAt: string | null) =>
        found.some((pullRequest) => isOwn(pullRequest) && mergedSince(pullRequest, workStartedAt))
      const settled = yield* threads.settleMerged(
        threadId,
        (latest, workStartedAt) => canAutoSettle(latest) && ownMergedSince(workStartedAt),
      )
      if (Option.isNone(settled)) return
      yield* events.publish({ type: "thread.updated", thread: settled.value })
      yield* runner.release(threadId, terminals.closeThread(threadId))
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("auto settle skipped a thread", threadId, cause)))

  const settleIfIdle = (thread: Thread, links: ReadonlyArray<PullRequestLink>, days: number, now: number) =>
    Effect.gen(function* () {
      if (!isIdleFor(thread, days, now) || (yield* hasAgentWork(thread.id))) return
      const found = yield* Effect.forEach(links, (link) => github.pullRequest(link.url), { concurrency: 4 })
      if (found.some(isOpen) || (yield* hasListeningPort(thread.id))) return
      const isStillIdle = (latest: Thread) => latest.updatedAt === thread.updatedAt && isIdleFor(latest, days, now)
      if (!isStillIdle(yield* threads.get(thread.id))) return
      const settled = Option.flatten(
        yield* runner.release(
          thread.id,
          stopProcesses(thread.id).pipe(Effect.andThen(threads.settleIf(thread.id, isStillIdle))),
        ),
      )
      if (Option.isSome(settled)) yield* events.publish({ type: "thread.updated", thread: settled.value })
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("idle settle skipped a thread", thread.id, cause)))

  const losesUncommittedWork = (thread: Thread) =>
    Effect.gen(function* () {
      if (!(yield* settings.get).archive.removeWorktree || thread.worktreeId === null) return false
      const worktree = yield* worktrees.get(thread.worktreeId)
      if (worktree.status === "removed") return false
      return (yield* worktrees.checkoutState(worktree.id)) === "dirty"
    })

  const isArchiveDue = (thread: Thread, now: number) =>
    Effect.map(settings.get, ({ archive: { archiveAfterSettledDays: days } }) =>
      days === null ? false : isSettledFor(thread, days, now),
    )

  const archiveIfSettledLong = (thread: Thread, now: number) =>
    Effect.gen(function* () {
      if (!(yield* isArchiveDue(thread, now))) return
      const archiveIfStillDue = threads.archiveIf(thread.id, (latest) =>
        Effect.gen(function* () {
          if (yield* losesUncommittedWork(latest)) return false
          return yield* isArchiveDue(latest, now)
        }),
      )
      const archived = Option.flatten(
        yield* runner.release(thread.id, stopProcesses(thread.id).pipe(Effect.andThen(archiveIfStillDue))),
      )
      if (Option.isSome(archived)) yield* events.publish({ type: "thread.updated", thread: archived.value })
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("auto archive skipped a thread", thread.id, cause)))

  const sweep = Effect.gen(function* () {
    const { archive } = yield* settings.get
    const now = yield* Clock.currentTimeMillis
    const byThread = Map.groupBy(yield* pullRequests.listAll, (link) => link.threadId)
    if (archive.whenMerged && (yield* github.installed)) {
      yield* Effect.forEach(byThread, ([threadId, links]) => settleIfDone(threadId, links), { discard: true })
    }
    const all = yield* threads.list
    const { settleAfterIdleDays } = archive
    if (settleAfterIdleDays !== null) {
      yield* Effect.forEach(
        all,
        (thread) => settleIfIdle(thread, byThread.get(thread.id) ?? [], settleAfterIdleDays, now),
        { discard: true },
      )
    }
    if (archive.archiveAfterSettledDays !== null) {
      yield* Effect.forEach(all, (thread) => archiveIfSettledLong(thread, now), { discard: true })
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("auto settle sweep failed", cause)))

  yield* Effect.schedule(sweep, Schedule.spaced(SWEEP_INTERVAL)).pipe(Effect.forkScoped)

  return Settle.of({ settle, sweep })
})

export const layer = Layer.effect(Settle, make)
