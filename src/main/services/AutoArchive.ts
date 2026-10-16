import { Context, Effect, Layer, Schedule } from "effect"
import { isThreadBusy, type PullRequestLink } from "../../shared/domain.ts"
import { Events } from "./Events.ts"
import { GitHub } from "./GitHub.ts"
import { PullRequests } from "./PullRequests.ts"
import { Settings } from "./Settings.ts"
import { Threads } from "./Threads.ts"

const SWEEP_INTERVAL = "3 minutes"

/** Archives threads whose linked pull requests have all merged, while `Settings.archive.whenMerged` is on. */
export class AutoArchive extends Context.Service<AutoArchive, { readonly sweep: Effect.Effect<void> }>()(
  "hinacode/AutoArchive",
) {}

const make = Effect.gen(function* () {
  const settings = yield* Settings
  const threads = yield* Threads
  const pullRequests = yield* PullRequests
  const github = yield* GitHub
  const events = yield* Events

  const archiveIfMerged = (threadId: string, links: ReadonlyArray<PullRequestLink>) =>
    Effect.gen(function* () {
      const thread = yield* threads.get(threadId)
      if (thread.status === "archived" || isThreadBusy(thread.status)) return
      const merged = yield* Effect.forEach(links, (link) => github.pullRequest(link.url), { concurrency: 4 }).pipe(
        Effect.map((found) => found.every((pullRequest) => pullRequest.status === "merged")),
      )
      if (!merged) return
      yield* events.publish({ type: "thread.updated", thread: yield* threads.archive(threadId) })
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("auto archive skipped a thread", threadId, cause)))

  const sweep = Effect.gen(function* () {
    if (!(yield* settings.get).archive.whenMerged) return
    const byThread = Map.groupBy(yield* pullRequests.listAll, (link) => link.threadId)
    yield* Effect.forEach(byThread, ([threadId, links]) => archiveIfMerged(threadId, links), { discard: true })
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("auto archive sweep failed", cause)))

  yield* Effect.schedule(sweep, Schedule.spaced(SWEEP_INTERVAL)).pipe(Effect.forkScoped)

  return AutoArchive.of({ sweep })
})

export const layer = Layer.effect(AutoArchive, make)
