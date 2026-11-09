import { Context, Effect, Layer, PubSub, Schedule } from "effect"
import type { PullRequest, PullRequestStatus, PullRequestTopic } from "../../shared/domain.ts"
import { EventBus, type PullRequestLinkedEvent } from "./EventBus.ts"
import { SourceControl } from "./SourceControl.ts"
import { PullRequests } from "./PullRequests.ts"
import { Threads } from "./Threads.ts"

const SWEEP_CONCURRENCY = 4

export class PullRequestLifecycle extends Context.Service<
  PullRequestLifecycle,
  {
    readonly announce: (event: PullRequestLinkedEvent) => Effect.Effect<void>
    readonly sweep: Effect.Effect<void>
  }
>()("hinacode/PullRequestLifecycle") {}

const settledTopic = (status: PullRequestStatus): PullRequestTopic | null => {
  switch (status) {
    case "merged":
      return "pullRequest.merged"
    case "closed":
      return "pullRequest.closed"
    case "draft":
    case "open":
      return null
  }
}

const make = Effect.gen(function* () {
  const bus = yield* EventBus
  const sourceControl = yield* SourceControl
  const pullRequests = yield* PullRequests
  const threads = yield* Threads

  const settle = (
    link: { readonly id: string; readonly threadId: string },
    pullRequest: PullRequest,
    openedByThread: boolean,
  ) =>
    Effect.gen(function* () {
      const observation = yield* pullRequests.observe(link.id, pullRequest.status)
      if (observation === null) return
      const topic = settledTopic(pullRequest.status)
      if (topic === null || (observation.previous === null && !openedByThread)) return
      yield* PubSub.publish(bus, { topic, threadId: link.threadId, pullRequest })
    })

  const announce = ({ threadId, linkId, url }: PullRequestLinkedEvent) =>
    Effect.gen(function* () {
      const [pullRequest, openedAt] = yield* Effect.all(
        [sourceControl.pullRequest(url), sourceControl.pullRequestOpenedAt(url)],
        {
          concurrency: "unbounded",
        },
      ).pipe(Effect.retry({ times: 2, schedule: Schedule.spaced("5 seconds") }))
      const thread = yield* threads.get(threadId)
      const openedByThread = Date.parse(openedAt) >= Date.parse(thread.createdAt)
      if (openedByThread) yield* PubSub.publish(bus, { topic: "pullRequest.opened", threadId, pullRequest })
      yield* settle({ id: linkId, threadId }, pullRequest, openedByThread)
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("could not announce a linked pull request", url, cause)))

  const sweep = Effect.gen(function* () {
    const readable = yield* Effect.filter(yield* pullRequests.unsettled, (link) => sourceControl.installedFor(link.url))
    const byUrl = Map.groupBy(readable, (link) => link.url)
    yield* Effect.forEach(
      byUrl,
      ([url, links]) =>
        sourceControl.pullRequest(url).pipe(
          Effect.flatMap((pullRequest) =>
            Effect.forEach(links, (link) => settle(link, pullRequest, false), { discard: true }),
          ),
          Effect.catchCause((cause) => Effect.logWarning("pull request lifecycle skipped a read", url, cause)),
        ),
      { concurrency: SWEEP_CONCURRENCY, discard: true },
    )
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("pull request lifecycle sweep failed", cause)))

  return PullRequestLifecycle.of({ announce, sweep })
})

export const layer = Layer.effect(PullRequestLifecycle, make)
