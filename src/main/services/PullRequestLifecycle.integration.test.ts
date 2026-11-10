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

const github = {
  statuses: new Map<string, PullRequestStatus>(),
  reads: new Array<string>(),
  installed: true,
}

const gitHub = Layer.mock(GitHub, {
  installed: Effect.sync(() => github.installed),
  pullRequest: (url) => {
    github.reads.push(url)
    return Effect.succeed({ url, status: github.statuses.get(url) ?? "open" } as PullRequest)
  },
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

const linkPullRequest = (status: PullRequestStatus = "open") =>
  Effect.gen(function* () {
    nextRepo += 1
    const name = `repo-${nextRepo}`
    const rootPath = join(base, name)
    mkdirSync(rootPath)
    const { threadId } = yield* seedThread({ rootPath })
    const url = `https://github.com/o/${name}/pull/1`
    github.statuses.set(url, status)
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
    it.effect("reads no pull request while gh is not installed", () =>
      Effect.gen(function* () {
        const { url } = yield* linkPullRequest()
        github.installed = false
        github.reads.length = 0
        yield* sweep.pipe(Effect.ensuring(Effect.sync(() => (github.installed = true))))
        expect(github.reads).not.toContain(url)
        expect(github.reads).toEqual([])
      }),
    )

    it.effect("records the status of a newly linked pull request", () =>
      Effect.gen(function* () {
        const { linked } = yield* linkPullRequest("draft")
        yield* announce(linked)
        expect(yield* observedStatus(linked.linkId)).toBe("draft")
      }),
    )

    it.effect("follows a pull request through close and reopen, and never reads it again once merged", () =>
      Effect.gen(function* () {
        const { linked, url } = yield* linkPullRequest()
        yield* announce(linked)
        for (const status of ["closed", "draft", "open", "merged"] as const) {
          github.statuses.set(url, status)
          yield* sweep
          expect(yield* observedStatus(linked.linkId)).toBe(status)
        }
        github.reads.length = 0
        yield* sweep
        expect(github.reads).not.toContain(url)
      }),
    )

    it.effect("lets only one observer move a link", () =>
      Effect.gen(function* () {
        const { linked } = yield* linkPullRequest()
        const observe = PullRequests.use((pullRequests) => pullRequests.observe(linked.linkId, "merged"))
        const results = yield* Effect.all([observe, observe], { concurrency: "unbounded" })
        expect(results.filter((result) => result !== null)).toEqual([{ previous: null }])
      }),
    )

    it.effect("does not link twice", () =>
      Effect.gen(function* () {
        const { subscription, threadId, url } = yield* linkPullRequest()
        yield* PullRequests.use((pullRequests) => pullRequests.link(threadId, url))
        expect(yield* drain(subscription)).toEqual([])
      }),
    )

    it.effect("reads a pull request linked to two threads once per sweep", () =>
      Effect.gen(function* () {
        const { linked, url } = yield* linkPullRequest()
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
