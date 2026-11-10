import { Context, Effect, Layer, Schedule } from "effect"
import type { PullRequest } from "../../shared/domain.ts"
import type { PullRequestLinkedEvent } from "./EventBus.ts"
import { SourceControl } from "./SourceControl.ts"
import { PullRequests } from "./PullRequests.ts"

const SWEEP_CONCURRENCY = 4

export class PullRequestLifecycle extends Context.Service<
  PullRequestLifecycle,
  {
    readonly announce: (event: PullRequestLinkedEvent) => Effect.Effect<void>
    readonly sweep: Effect.Effect<void>
  }
>()("hinacode/PullRequestLifecycle") {}

const make = Effect.gen(function* () {
  const sourceControl = yield* SourceControl
  const pullRequests = yield* PullRequests

  const settle = (linkId: string, pullRequest: PullRequest) =>
    Effect.asVoid(pullRequests.observe(linkId, pullRequest.status))

  const announce = ({ linkId, url }: PullRequestLinkedEvent) =>
    sourceControl.pullRequest(url).pipe(
      Effect.retry({ times: 2, schedule: Schedule.spaced("5 seconds") }),
      Effect.flatMap((pullRequest) => settle(linkId, pullRequest)),
      Effect.catchCause((cause) => Effect.logWarning("could not announce a linked pull request", url, cause)),
    )

  const sweep = Effect.gen(function* () {
    const readable = yield* Effect.filter(yield* pullRequests.unsettled, (link) => sourceControl.installedFor(link.url))
    const byUrl = Map.groupBy(readable, (link) => link.url)
    yield* Effect.forEach(
      byUrl,
      ([url, links]) =>
        sourceControl.pullRequest(url).pipe(
          Effect.flatMap((pullRequest) =>
            Effect.forEach(links, (link) => settle(link.id, pullRequest), { discard: true }),
          ),
          Effect.catchCause((cause) => Effect.logWarning("pull request lifecycle skipped a read", url, cause)),
        ),
      { concurrency: SWEEP_CONCURRENCY, discard: true },
    )
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("pull request lifecycle sweep failed", cause)))

  return PullRequestLifecycle.of({ announce, sweep })
})

export const layer = Layer.effect(PullRequestLifecycle, make)
