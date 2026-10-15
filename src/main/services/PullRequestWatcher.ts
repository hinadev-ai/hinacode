import { Context, Effect, Layer, Schedule, Semaphore } from "effect"
import type { PullRequestLink, PullRequestWatch } from "../../shared/domain.ts"
import { AgentRunner } from "./AgentRunner.ts"
import { nowIso } from "./clock.ts"
import { GitHub } from "./GitHub.ts"
import { snapshotFromDetail, watchEvents, watchMessage, watchStoppedMessage } from "./pullRequestWatch.ts"
import { PullRequests } from "./PullRequests.ts"
import { Threads } from "./Threads.ts"

const POLL_INTERVAL = "1 minute"
/** A watch ends itself after this many wakes, so a long-lived pull request cannot loop a thread forever. */
const MAX_WAKES = 25
/** Consecutive unreadable polls before a watch gives up. At one poll a minute this is about 15 minutes. */
const MAX_FAILURES = 15

/**
 * Polls every watched pull request once a minute and wakes its thread with what changed. A watch's
 * snapshot only moves when its news was delivered or when a poll found no news, so a thread that cannot
 * take a wake yet gets the same news on a later poll instead of a queue building up behind it.
 */
export class PullRequestWatcher extends Context.Service<PullRequestWatcher, { readonly sweep: Effect.Effect<void> }>()(
  "kkcode/PullRequestWatcher",
) {}

const make = Effect.gen(function* () {
  const pullRequests = yield* PullRequests
  const github = yield* GitHub
  const threads = yield* Threads
  const runner = yield* AgentRunner
  const semaphore = Semaphore.makeUnsafe(1)

  const stillCurrent = (linkId: string, generation: PullRequestWatch["generation"]) =>
    Effect.map(pullRequests.find(linkId), (current) => current?.watch?.generation === generation)

  const canDeliver = (link: PullRequestLink, generation: PullRequestWatch["generation"]) =>
    threads.get(link.threadId).pipe(
      Effect.flatMap((thread) =>
        thread.status === "idle" || thread.status === "running"
          ? stillCurrent(link.id, generation)
          : Effect.succeed(false),
      ),
      Effect.catchTag("NotFoundError", () => Effect.succeed(false)),
    )

  const record = (link: PullRequestLink, watch: PullRequestWatch, patch: Partial<PullRequestWatch>) =>
    pullRequests.updateWatch(link.id, watch.generation, { ...watch, ...patch })

  const wake = (link: PullRequestLink, generation: PullRequestWatch["generation"], text: string) =>
    runner
      .steerWhen({
        threadId: link.threadId,
        text,
        attachments: [],
        when: canDeliver(link, generation),
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pull request watch could not wake the thread", link.threadId, cause).pipe(
            Effect.as(false),
          ),
        ),
      )

  /** Ends the watch and tells the thread why, unless the thread cannot take a message right now. */
  const stopWithWake = (link: PullRequestLink, watch: PullRequestWatch, reason: string) =>
    Effect.gen(function* () {
      const thread = yield* threads.get(link.threadId)
      if (thread.status !== "archived" && thread.status !== "awaiting_approval" && thread.status !== "limited") {
        if (yield* stillCurrent(link.id, watch.generation)) {
          yield* wake(link, watch.generation, watchStoppedMessage(link.url, reason))
        }
      }
      yield* pullRequests.updateWatch(link.id, watch.generation, null)
    })

  const poll = (link: PullRequestLink) =>
    Effect.gen(function* () {
      const watch = link.watch
      if (watch === null) return
      const now = yield* nowIso
      const read = yield* Effect.result(github.pullRequestDetail(link.url))

      if (read._tag === "Failure") {
        const failures = watch.failures + 1
        if (failures >= MAX_FAILURES) {
          yield* stopWithWake(
            link,
            watch,
            `GitHub could not be read ${MAX_FAILURES} times in a row (last error: ${read.failure.message}).`,
          )
        } else {
          yield* record(link, watch, { failures, lastPolledAt: now })
        }
        return
      }

      const detail = read.success
      const snapshot = snapshotFromDetail(detail)
      const events = watchEvents(watch.snapshot, snapshot, watch.events)
      const terminal = detail.status === "merged" || detail.status === "closed"
      const thread = yield* threads.get(link.threadId)

      if (thread.status === "archived") {
        yield* pullRequests.updateWatch(link.id, watch.generation, null)
        return
      }
      if (events.length === 0) {
        yield* terminal
          ? pullRequests.updateWatch(link.id, watch.generation, null)
          : record(link, watch, { snapshot, failures: 0, lastPolledAt: now })
        return
      }
      if (thread.status === "awaiting_approval" || thread.status === "limited") {
        yield* record(link, watch, { failures: 0, lastPolledAt: now })
        return
      }
      if (!(yield* stillCurrent(link.id, watch.generation))) return

      const wakes = watch.wakes + 1
      const capped = !terminal && wakes >= MAX_WAKES
      const text = capped
        ? `${watchMessage(detail, watch.snapshot, events)}\n\nWatching has ended after ${MAX_WAKES} updates. Call the KKCode \`watch_pull_request\` tool to watch it again.`
        : watchMessage(detail, watch.snapshot, events)
      if (!(yield* wake(link, watch.generation, text))) {
        yield* record(link, watch, { failures: 0, lastPolledAt: now })
        return
      }
      yield* terminal || capped
        ? pullRequests.updateWatch(link.id, watch.generation, null)
        : record(link, watch, { snapshot, wakes, failures: 0, lastPolledAt: now, lastWokeAt: now })
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("pull request watch poll failed", link.url, cause)))

  const sweep = Semaphore.withPermit(
    semaphore,
    Effect.gen(function* () {
      const links = yield* pullRequests.watched
      yield* Effect.forEach(links, poll, { concurrency: 4, discard: true })
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("pull request watch sweep failed", cause))),
  )

  yield* Effect.schedule(sweep, Schedule.spaced(POLL_INTERVAL)).pipe(Effect.forkScoped)

  return PullRequestWatcher.of({ sweep })
})

export const layer = Layer.effect(PullRequestWatcher, make)
