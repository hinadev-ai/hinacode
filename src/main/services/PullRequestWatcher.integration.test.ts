import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Deferred, Effect, Fiber, Layer } from "effect"
import type { PushEvent } from "../../shared/contract.ts"
import type { PullRequestDetail, ThreadStatus } from "../../shared/domain.ts"
import { allWatchEventKinds } from "../../shared/domain.ts"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import * as AgentAccounts from "./AgentAccounts.ts"
import { AgentRunner } from "./AgentRunner.ts"
import { Events } from "./Events.ts"
import * as Git from "./Git.ts"
import { GitHub, GitHubCliMissingError } from "./GitHub.ts"
import * as Projects from "./Projects.ts"
import { PullRequests, layer as pullRequestsLayer } from "./PullRequests.ts"
import { PullRequestWatcher, layer as watcherLayer } from "./PullRequestWatcher.ts"
import { layer as settingsLayer } from "./Settings.ts"
import * as Terminals from "./Terminals.ts"
import { Threads, layer as threadsLayer } from "./Threads.ts"
import * as Worktrees from "./Worktrees.ts"
import * as Scratch from "./Scratch.ts"

const pushes: Array<PushEvent> = []
const wakes: Array<{ readonly threadId: string; readonly text: string }> = []
const details = new Map<string, PullRequestDetail>()
const unreadable = new Set<string>()
const held = new Map<string, { readonly asked: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }>()

const gitHub = Layer.mock(GitHub, {
  pullRequestDetail: (url) =>
    Effect.gen(function* () {
      const hold = held.get(url)
      if (hold) {
        yield* Deferred.succeed(hold.asked, undefined)
        yield* Deferred.await(hold.release)
      }
      if (unreadable.has(url)) return yield* new GitHubCliMissingError()
      const detail = details.get(url)
      if (detail === undefined) return yield* Effect.die(new Error(`no detail seeded for ${url}`))
      return detail
    }),
})

const runner = Layer.mock(AgentRunner, {
  steerWhen: ({ threadId, text, when }) =>
    Effect.gen(function* () {
      if (!(yield* when)) return false
      wakes.push({ threadId, text })
      return true
    }),
})

const base = realpathSync(mkdtempSync(join(tmpdir(), "kk-pr-watcher-")))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const domain = threadsLayer.pipe(
  Layer.provideMerge(Scratch.layer(mkdtempSync(join(tmpdir(), "kk-scratch-")))),
  Layer.provideMerge(Terminals.layer),
  Layer.provideMerge(Worktrees.layer),
  Layer.provideMerge(Projects.layer),
  Layer.provide(AgentAccounts.layer),
  Layer.provideMerge(settingsLayer(mkdtempSync(join(tmpdir(), "kk-watcher-settings-")))),
)
const testLayer = watcherLayer.pipe(
  Layer.provideMerge(pullRequestsLayer),
  Layer.provideMerge(domain),
  Layer.provide(Layer.mergeAll(Git.layer, gitHub, runner)),
  Layer.provide(Layer.succeed(Events, { publish: (event) => Effect.sync(() => void pushes.push(event)) })),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(NodeServices.layer),
)

const detailFor = (url: string, overrides: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
  url,
  number: 7,
  title: "Fix the thing",
  status: "open",
  checks: "pending",
  review: null,
  author: "octocat",
  headRefName: "feat/fix",
  baseRefName: "main",
  additions: 1,
  deletions: 0,
  body: "",
  baseRef: "main",
  headRef: "feat/fix",
  head: "abc1234",
  mergeable: "mergeable",
  changedFiles: 1,
  comments: [],
  checkRuns: [],
  ...overrides,
})

const failing = (url: string, overrides: Partial<PullRequestDetail> = {}) =>
  detailFor(url, {
    checks: "failing",
    checkRuns: [{ name: "CI / test", status: "failing", url: "https://ci.example/test" }],
    ...overrides,
  })

const watchedThread = (name: string, make: (url: string) => PullRequestDetail, status?: ThreadStatus) =>
  Effect.gen(function* () {
    const rootPath = join(base, name)
    mkdirSync(rootPath)
    const { threadId } = yield* seedThread({ rootPath })
    if (status) yield* Threads.use((threads) => threads.update({ id: threadId, status }))
    const url = `https://github.com/o/${name}/pull/7`
    details.set(url, make(url))
    yield* PullRequests.use((pullRequests) => pullRequests.watch(threadId, url))
    return { threadId, url }
  })

const sweep = PullRequestWatcher.use((watcher) => watcher.sweep)
const linkOf = (threadId: string) =>
  PullRequests.use((pullRequests) => pullRequests.list(threadId)).pipe(Effect.map((links) => links[0]))
const wakesFor = (threadId: string) => wakes.filter((wake) => wake.threadId === threadId)

describe("PullRequestWatcher", () => {
  layer(testLayer)((it) => {
    it.effect("wakes the thread once when a check fails, then stays quiet", () =>
      Effect.gen(function* () {
        const { threadId, url } = yield* watchedThread("failing", (u) => detailFor(u))
        yield* sweep
        expect(wakesFor(threadId)).toStrictEqual([])

        details.set(url, failing(url))
        yield* sweep
        yield* sweep

        const sent = wakesFor(threadId)
        expect(sent).toHaveLength(1)
        expect(sent[0]?.text).toContain("CI / test")
        expect((yield* linkOf(threadId))?.watch).toMatchObject({ wakes: 1, failures: 0 })
        expect((yield* linkOf(threadId))?.watch?.snapshot?.failingChecks).toStrictEqual(["CI / test"])
      }),
    )

    it.effect("defers the wake while the thread waits on an approval", () =>
      Effect.gen(function* () {
        const { threadId } = yield* watchedThread("deferred", (u) => failing(u), "awaiting_approval")
        yield* sweep
        expect(wakesFor(threadId)).toStrictEqual([])
        expect((yield* linkOf(threadId))?.watch?.snapshot).toBeNull()

        yield* Threads.use((threads) => threads.update({ id: threadId, status: "idle" }))
        yield* sweep
        expect(wakesFor(threadId)).toHaveLength(1)
      }),
    )

    it.effect("reports a merge and ends the watch", () =>
      Effect.gen(function* () {
        const { threadId, url } = yield* watchedThread("merged", (u) => detailFor(u))
        yield* sweep
        details.set(url, detailFor(url, { status: "merged", checks: "passing" }))
        yield* sweep

        const sent = wakesFor(threadId)
        expect(sent).toHaveLength(1)
        expect(sent[0]?.text).toContain("merged")
        expect((yield* linkOf(threadId))?.watch).toBeNull()
      }),
    )

    it.effect("clears the watch of an archived thread without waking it", () =>
      Effect.gen(function* () {
        const { threadId } = yield* watchedThread("archived", (u) => failing(u))
        yield* Threads.use((threads) => threads.update({ id: threadId, status: "archived" }))
        yield* sweep
        expect(wakesFor(threadId)).toStrictEqual([])
        expect((yield* linkOf(threadId))?.watch).toBeNull()
      }),
    )

    it.effect("drops a poll whose watch was stopped while GitHub was answering", () =>
      Effect.gen(function* () {
        const { threadId, url } = yield* watchedThread("stopped", (u) => failing(u))
        const hold = { asked: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
        held.set(url, hold)

        const running = yield* Effect.forkChild(sweep)
        yield* Deferred.await(hold.asked)
        yield* PullRequests.use((pullRequests) => pullRequests.unwatch(threadId, url))
        yield* Deferred.succeed(hold.release, undefined)
        yield* Fiber.join(running)

        expect(wakesFor(threadId)).toStrictEqual([])
        expect((yield* linkOf(threadId))?.watch).toBeNull()
      }),
    )

    it.effect("drops a stopped watch's poll after a replacement watch starts", () =>
      Effect.gen(function* () {
        const { threadId, url } = yield* watchedThread("restarted-after-stop", (u) => failing(u))
        const hold = { asked: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
        held.set(url, hold)
        const pullRequests = yield* PullRequests
        const original = yield* linkOf(threadId)

        const running = yield* Effect.forkChild(sweep)
        yield* Deferred.await(hold.asked)
        yield* pullRequests.unwatch(threadId, url)
        const replacement = yield* pullRequests.watch(threadId, url, ["reviewChanged"])
        yield* Deferred.succeed(hold.release, undefined)
        yield* Fiber.join(running)

        expect(wakesFor(threadId)).toStrictEqual([])
        expect((yield* linkOf(threadId))?.watch).toStrictEqual(replacement.watch)
        expect(replacement.watch?.generation).not.toBe(original?.watch?.generation)
      }),
    )

    it.effect("gives up after repeated read failures and tells the thread why", () =>
      Effect.gen(function* () {
        const { threadId, url } = yield* watchedThread("unreadable", (u) => detailFor(u))
        unreadable.add(url)
        for (let poll = 0; poll < 15; poll++) yield* sweep

        const sent = wakesFor(threadId)
        expect(sent).toHaveLength(1)
        expect(sent[0]?.text).toContain("could not be read")
        expect((yield* linkOf(threadId))?.watch).toBeNull()
      }),
    )
  })
})

describe("PullRequests watch persistence", () => {
  layer(testLayer)((it) => {
    it.effect("watching links first, restarting replaces the generation, stale generations cannot write", () =>
      Effect.gen(function* () {
        const rootPath = join(base, "persistence")
        mkdirSync(rootPath)
        const { threadId } = yield* seedThread({ rootPath })
        const url = "https://github.com/o/persistence/pull/3"
        details.set(url, detailFor(url))

        const pullRequests = yield* PullRequests
        const first = yield* pullRequests.watch(threadId, url, ["checksFailed"])
        const firstWatch = first.watch
        if (firstWatch === null) throw new Error("watch missing after start")
        expect(firstWatch).toMatchObject({ generation: expect.any(String), events: ["checksFailed"], snapshot: null })
        expect(pushes).toContainEqual(expect.objectContaining({ type: "thread.pullRequests", threadId }))

        const restarted = yield* pullRequests.watch(threadId, url)
        expect(restarted.watch?.generation).not.toBe(firstWatch.generation)
        expect(restarted.watch?.events).toStrictEqual(allWatchEventKinds)

        const current = restarted.watch
        if (current === null) throw new Error("watch missing after restart")
        expect(yield* pullRequests.updateWatch(restarted.id, firstWatch.generation, null)).toBe(false)
        expect((yield* pullRequests.find(restarted.id))?.watch?.generation).toBe(current.generation)
        expect(yield* pullRequests.updateWatch(restarted.id, current.generation, { ...current, wakes: 3 })).toBe(true)
        expect((yield* pullRequests.find(restarted.id))?.watch?.wakes).toBe(3)

        yield* pullRequests.unwatch(threadId, url)
        const after = yield* pullRequests.list(threadId)
        expect(after).toHaveLength(1)
        expect(after[0]?.watch).toBeNull()
      }),
    )
  })
})
