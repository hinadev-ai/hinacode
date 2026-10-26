import { Context, Effect, Layer, Schedule } from "effect"
import { isThreadBusy, type PullRequest, type PullRequestLink } from "../../shared/domain.ts"
import { Events } from "./Events.ts"
import { GitHub } from "./GitHub.ts"
import { PullRequests } from "./PullRequests.ts"
import { Settings } from "./Settings.ts"
import { Threads } from "./Threads.ts"
import { forkPullRequestBranch, Worktrees } from "./Worktrees.ts"

const SWEEP_INTERVAL = "3 minutes"

/**
 * Archives threads that are done with their pull requests, while `Settings.archive.whenMerged` is on.
 * A thread in a worktree is done once the pull request of its own branch has merged or closed. Pull requests
 * of other branches it linked, such as a conductor's children, hold it only while it watches them.
 * A thread without a worktree is done once every linked pull request has merged or closed.
 */
export class AutoArchive extends Context.Service<AutoArchive, { readonly sweep: Effect.Effect<void> }>()(
  "hinacode/AutoArchive",
) {}

const isFinished = (pullRequest: PullRequest) => pullRequest.status === "merged" || pullRequest.status === "closed"

const make = Effect.gen(function* () {
  const settings = yield* Settings
  const threads = yield* Threads
  const pullRequests = yield* PullRequests
  const github = yield* GitHub
  const events = yield* Events
  const worktrees = yield* Worktrees

  const ownBranch = (worktreeId: string | null) =>
    Effect.gen(function* () {
      if (worktreeId === null) return null
      const worktree = yield* worktrees.get(worktreeId)
      return worktree.status === "removed" ? null : worktree.branch
    })

  const archiveIfDone = (threadId: string, links: ReadonlyArray<PullRequestLink>) =>
    Effect.gen(function* () {
      const thread = yield* threads.get(threadId)
      if (thread.status === "archived" || isThreadBusy(thread.status)) return
      const branch = yield* ownBranch(thread.worktreeId)
      const found = yield* Effect.forEach(links, (link) => github.pullRequest(link.url), { concurrency: 4 })
      const isOwn = (pullRequest: PullRequest) =>
        branch === null || branch === pullRequest.headRefName || branch === forkPullRequestBranch(pullRequest.number)
      const done =
        found.some(isOwn) &&
        found.every(
          (pullRequest, index) => isFinished(pullRequest) || (!isOwn(pullRequest) && links[index]!.watch === null),
        )
      if (!done) return
      yield* events.publish({ type: "thread.updated", thread: yield* threads.archive(threadId) })
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("auto archive skipped a thread", threadId, cause)))

  const sweep = Effect.gen(function* () {
    if (!(yield* settings.get).archive.whenMerged) return
    const byThread = Map.groupBy(yield* pullRequests.listAll, (link) => link.threadId)
    yield* Effect.forEach(byThread, ([threadId, links]) => archiveIfDone(threadId, links), { discard: true })
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("auto archive sweep failed", cause)))

  yield* Effect.schedule(sweep, Schedule.spaced(SWEEP_INTERVAL)).pipe(Effect.forkScoped)

  return AutoArchive.of({ sweep })
})

export const layer = Layer.effect(AutoArchive, make)
