import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import * as SourceControl from "./SourceControl.ts"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, PubSub } from "effect"
import { SqlClient } from "effect/sql"
import type { PullRequest, PullRequestStatus } from "../../shared/domain.ts"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import * as AgentAccounts from "./AgentAccounts.ts"
import { type BusEvent, EventBus, type PullRequestLinkedEvent } from "./EventBus.ts"
import { Events } from "./Events.ts"
import * as Git from "./Git.ts"
import { GitHub } from "./GitHub.ts"
import * as Projects from "./Projects.ts"
import { PullRequestLifecycle, layer as lifecycleLayer } from "./PullRequestLifecycle.ts"
import { PullRequests, layer as pullRequestsLayer } from "./PullRequests.ts"
import * as Scratch from "./Scratch.ts"
import * as Settings from "./Settings.ts"
import * as Terminals from "./Terminals.ts"
import { layer as threadsLayer } from "./Threads.ts"
import * as Worktrees from "./Worktrees.ts"

const longAgo = "2000-01-01T00:00:00.000Z"
const farAhead = "2999-01-01T00:00:00.000Z"

const github = {
  statuses: new Map<string, PullRequestStatus>(),
  openedAt: new Map<string, string>(),
  reads: new Array<string>(),
}

const gitHub = Layer.mock(GitHub, {
  pullRequest: (url) => {
    github.reads.push(url)
    return Effect.succeed({ url, status: github.statuses.get(url) ?? "open" } as PullRequest)
  },
  pullRequestOpenedAt: (url) => Effect.succeed(github.openedAt.get(url) ?? longAgo),
})

const base = realpathSync(mkdtempSync(join(tmpdir(), "kk-lifecycle-")))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const domain = threadsLayer.pipe(
  Layer.provideMerge(Scratch.layer(mkdtempSync(join(tmpdir(), "kk-lifecycle-scratch-")))),
  Layer.provideMerge(Terminals.layer),
  Layer.provideMerge(Worktrees.layer),
  Layer.provideMerge(Projects.layer),
  Layer.provide(AgentAccounts.layer),
  Layer.provideMerge(Settings.layer(mkdtempSync(join(tmpdir(), "kk-lifecycle-settings-")))),
)
const testLayer = lifecycleLayer.pipe(
  Layer.provideMerge(pullRequestsLayer),
  Layer.provideMerge(domain),
  Layer.provideMerge(SourceControl.layer),
  Layer.provideMerge(Layer.mergeAll(Git.layer, gitHub)),
  Layer.provide(Layer.succeed(Events, { publish: () => Effect.void })),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(NodeServices.layer),
)

let nextRepo = 0

const linkPullRequest = (options: { readonly openedAt: string; readonly status?: PullRequestStatus }) =>
  Effect.gen(function* () {
    nextRepo += 1
    const name = `repo-${nextRepo}`
    const rootPath = join(base, name)
    mkdirSync(rootPath)
    const { threadId } = yield* seedThread({ rootPath })
    const url = `https://github.com/o/${name}/pull/1`
    github.statuses.set(url, options.status ?? "open")
    github.openedAt.set(url, options.openedAt)
    const bus = yield* EventBus
    const subscription = yield* PubSub.subscribe(bus)
    yield* PullRequests.use((pullRequests) => pullRequests.link(threadId, url))
    const linked = yield* PubSub.take(subscription)
    if (linked.topic !== "pullRequest.linked") throw new Error(`expected linked, got ${linked.topic}`)
    return { threadId, url, linked, subscription }
  })

const announce = (linked: PullRequestLinkedEvent) => PullRequestLifecycle.use((lifecycle) => lifecycle.announce(linked))
const sweep = PullRequestLifecycle.use((lifecycle) => lifecycle.sweep)
const drain = (subscription: PubSub.Subscription<BusEvent>) => PubSub.takeUpTo(subscription, Number.MAX_SAFE_INTEGER)
const topics = (events: ReadonlyArray<BusEvent>) => events.map((event) => event.topic)
const observedStatus = (linkId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly observedStatus: string | null }>`
      SELECT observed_status FROM pull_request_link WHERE id = ${linkId}
    `
    return rows[0]?.observedStatus
  })

describe("PullRequestLifecycle", () => {
  layer(testLayer)((it) => {
    it.effect("announces a pull request created after its thread", () =>
      Effect.gen(function* () {
        const { linked, subscription, threadId, url } = yield* linkPullRequest({ openedAt: farAhead })
        yield* announce(linked)
        const events = yield* drain(subscription)
        expect(topics(events)).toEqual(["pullRequest.opened"])
        expect(events[0]).toMatchObject({ threadId, pullRequest: { url } })
      }),
    )

    it.effect("stays quiet about an older pull request a thread picked up, until it merges", () =>
      Effect.gen(function* () {
        const { linked, subscription, url } = yield* linkPullRequest({ openedAt: longAgo })
        yield* announce(linked)
        expect(topics(yield* drain(subscription))).toEqual([])
        github.statuses.set(url, "merged")
        yield* sweep
        expect(topics(yield* drain(subscription))).toEqual(["pullRequest.merged"])
      }),
    )

    it.effect("reports a pull request opened and merged before anyone observed it", () =>
      Effect.gen(function* () {
        const { linked, subscription } = yield* linkPullRequest({ openedAt: farAhead, status: "merged" })
        yield* announce(linked)
        expect(topics(yield* drain(subscription))).toEqual(["pullRequest.opened", "pullRequest.merged"])
      }),
    )

    it.effect("records the first sweep of a link silently so upgrading replays no history", () =>
      Effect.gen(function* () {
        const { subscription } = yield* linkPullRequest({ openedAt: farAhead, status: "merged" })
        yield* sweep
        expect(topics(yield* drain(subscription))).toEqual([])
      }),
    )

    it.effect("publishes a merge once and never reads a settled pull request again", () =>
      Effect.gen(function* () {
        const { linked, subscription, url } = yield* linkPullRequest({ openedAt: longAgo })
        yield* announce(linked)
        github.statuses.set(url, "merged")
        yield* sweep
        yield* drain(subscription)
        github.reads.length = 0
        yield* sweep
        expect(github.reads).not.toContain(url)
        expect(topics(yield* drain(subscription))).toEqual([])
      }),
    )

    it.effect("publishes closed and ignores open to draft", () =>
      Effect.gen(function* () {
        const { linked, subscription, url } = yield* linkPullRequest({ openedAt: longAgo })
        yield* announce(linked)
        github.statuses.set(url, "draft")
        yield* sweep
        expect(topics(yield* drain(subscription))).toEqual([])
        github.statuses.set(url, "closed")
        yield* sweep
        expect(topics(yield* drain(subscription))).toEqual(["pullRequest.closed"])
      }),
    )

    it.effect("publishes a merge after a closed pull request reopens, and closed only once", () =>
      Effect.gen(function* () {
        const { linked, subscription, url } = yield* linkPullRequest({ openedAt: longAgo })
        yield* announce(linked)

        const expectAfterSweep = (status: PullRequestStatus, expectedTopics: ReadonlyArray<BusEvent["topic"]>) =>
          Effect.gen(function* () {
            github.statuses.set(url, status)
            yield* sweep
            expect(yield* observedStatus(linked.linkId)).toBe(status)
            expect(topics(yield* drain(subscription))).toEqual(expectedTopics)
          })

        yield* expectAfterSweep("closed", ["pullRequest.closed"])
        yield* expectAfterSweep("closed", [])
        yield* expectAfterSweep("open", [])
        yield* expectAfterSweep("merged", ["pullRequest.merged"])

        github.reads.length = 0
        yield* sweep
        expect(github.reads).not.toContain(url)
        expect(yield* observedStatus(linked.linkId)).toBe("merged")
        expect(topics(yield* drain(subscription))).toEqual([])
      }),
    )

    it.effect("follows a closed pull request reopened as a draft through to its merge", () =>
      Effect.gen(function* () {
        const { linked, subscription, url } = yield* linkPullRequest({ openedAt: longAgo })
        yield* announce(linked)
        github.statuses.set(url, "closed")
        yield* sweep
        github.statuses.set(url, "draft")
        yield* sweep
        expect(yield* observedStatus(linked.linkId)).toBe("draft")
        github.statuses.set(url, "merged")
        yield* sweep
        expect(yield* observedStatus(linked.linkId)).toBe("merged")
        expect(topics(yield* drain(subscription))).toEqual(["pullRequest.closed", "pullRequest.merged"])
      }),
    )

    it.effect("publishes a merge when the reopen happened between two sweeps", () =>
      Effect.gen(function* () {
        const { linked, subscription, url } = yield* linkPullRequest({ openedAt: longAgo })
        yield* announce(linked)
        github.statuses.set(url, "closed")
        yield* sweep
        github.statuses.set(url, "merged")
        yield* sweep
        expect(yield* observedStatus(linked.linkId)).toBe("merged")
        expect(topics(yield* drain(subscription))).toEqual(["pullRequest.closed", "pullRequest.merged"])
      }),
    )

    it.effect("lets only one observer move a link", () =>
      Effect.gen(function* () {
        const { linked } = yield* linkPullRequest({ openedAt: longAgo })
        const observe = PullRequests.use((pullRequests) => pullRequests.observe(linked.linkId, "merged"))
        const results = yield* Effect.all([observe, observe], { concurrency: "unbounded" })
        expect(results.filter((result) => result !== null)).toEqual([{ previous: null }])
      }),
    )

    it.effect("does not link twice", () =>
      Effect.gen(function* () {
        const { subscription, threadId, url } = yield* linkPullRequest({ openedAt: longAgo })
        yield* PullRequests.use((pullRequests) => pullRequests.link(threadId, url))
        expect(topics(yield* drain(subscription))).toEqual([])
      }),
    )

    it.effect("reads a pull request linked to two threads once per sweep", () =>
      Effect.gen(function* () {
        const { linked, url } = yield* linkPullRequest({ openedAt: longAgo })
        yield* announce(linked)
        const second = join(base, "second-thread")
        mkdirSync(second)
        const other = yield* seedThread({ rootPath: second })
        yield* PullRequests.use((pullRequests) => pullRequests.link(other.threadId, url))
        github.reads.length = 0
        yield* sweep
        expect(github.reads.filter((read) => read === url)).toHaveLength(1)
      }),
    )
  })
})
