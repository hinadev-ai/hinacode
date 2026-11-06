import { Context, Effect, Layer, Option, Schedule } from "effect"
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

  const release = (threadId: string) =>
    Effect.gen(function* () {
      yield* runner.release(threadId)
      yield* terminals.closeThread(threadId)
      yield* ports.closeThread(threadId)
    })

  const hasAgentWork = (threadId: string) =>
    Effect.gen(function* () {
      const tasks = yield* runner.backgroundTasks(threadId)
      const subagents = yield* runner.subagents(threadId)
      return tasks.length > 0 || subagents.some((subagent) => subagent.status === "running")
    })

  const hasListeningPort = (threadId: string) =>
    ports.listForThread(threadId).pipe(
      Effect.map((open) => open.length > 0),
      Effect.orElseSucceed(() => false),
    )

  const settle = (threadId: string) =>
    Effect.gen(function* () {
      if (isThreadBusy((yield* threads.get(threadId)).status)) return yield* new ThreadBusyError({ id: threadId })
      yield* release(threadId)
      return yield* threads.settle(threadId)
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
      yield* release(threadId)
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("auto settle skipped a thread", threadId, cause)))

  const sweep = Effect.gen(function* () {
    if (!(yield* settings.get).archive.whenMerged) return
    const byThread = Map.groupBy(yield* pullRequests.listAll, (link) => link.threadId)
    yield* Effect.forEach(byThread, ([threadId, links]) => settleIfDone(threadId, links), { discard: true })
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("auto settle sweep failed", cause)))

  yield* Effect.schedule(sweep, Schedule.spaced(SWEEP_INTERVAL)).pipe(Effect.forkScoped)

  return Settle.of({ settle, sweep })
})

export const layer = Layer.effect(Settle, make)
