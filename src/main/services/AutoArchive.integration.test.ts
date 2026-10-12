import { describe, expect, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import type { PushEvent } from "../../shared/contract.ts"
import type { PullRequest, PullRequestStatus, ThreadStatus } from "../../shared/domain.ts"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import { AutoArchive, layer as autoArchiveLayer } from "./AutoArchive.ts"
import { Events } from "./Events.ts"
import * as Git from "./Git.ts"
import { GitHub } from "./GitHub.ts"
import * as Projects from "./Projects.ts"
import { PullRequests, layer as pullRequestsLayer } from "./PullRequests.ts"
import { Settings, layer as settingsLayer } from "./Settings.ts"
import * as Terminals from "./Terminals.ts"
import { Threads, layer as threadsLayer } from "./Threads.ts"
import * as Worktrees from "./Worktrees.ts"

const pushes: Array<PushEvent> = []
const statuses = new Map<string, PullRequestStatus>()

const gitHub = Layer.mock(GitHub, {
  pullRequest: (url) => Effect.succeed({ url, status: statuses.get(url) ?? "open" } as PullRequest),
})

const domain = threadsLayer.pipe(
  Layer.provideMerge(Worktrees.layer),
  Layer.provideMerge(Projects.layer),
  Layer.provideMerge(settingsLayer),
)
const testLayer = autoArchiveLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(pullRequestsLayer, Terminals.layer)),
  Layer.provideMerge(domain),
  Layer.provide(Layer.mergeAll(Git.layer, gitHub)),
  Layer.provide(Layer.succeed(Events, { publish: (event) => Effect.sync(() => void pushes.push(event)) })),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(NodeServices.layer),
)

/** A thread in its own project, linked to one pull request per given status. */
const threadWithPullRequests = (name: string, prStatuses: ReadonlyArray<PullRequestStatus>, status?: ThreadStatus) =>
  Effect.gen(function* () {
    const { threadId } = yield* seedThread({ rootPath: `/${name}` })
    if (status) yield* Threads.use((threads) => threads.update({ id: threadId, status }))
    yield* Effect.forEach(prStatuses, (prStatus, index) => {
      const url = `https://github.com/o/${name}/pull/${index + 1}`
      statuses.set(url, prStatus)
      return PullRequests.use((pullRequests) => pullRequests.link(threadId, url))
    })
    return threadId
  })

const statusOf = (id: string) => Threads.use((threads) => threads.get(id)).pipe(Effect.map((thread) => thread.status))

describe("AutoArchive", () => {
  layer(testLayer)((it) => {
    it.effect("leaves every thread alone while the setting is off", () =>
      Effect.gen(function* () {
        const merged = yield* threadWithPullRequests("off", ["merged"])
        yield* AutoArchive.use((autoArchive) => autoArchive.sweep)
        expect(yield* statusOf(merged)).toBe("idle")
      }),
    )

    it.effect("archives only threads whose linked pull requests are all merged", () =>
      Effect.gen(function* () {
        yield* Settings.use((settings) => settings.set({ archive: { whenMerged: true, removeWorktree: false } }))
        const allMerged = yield* threadWithPullRequests("all", ["merged", "merged"])
        const oneOpen = yield* threadWithPullRequests("some", ["merged", "open"])
        const closed = yield* threadWithPullRequests("closed", ["closed"])
        const running = yield* threadWithPullRequests("running", ["merged"], "running")
        const unlinked = (yield* seedThread({ rootPath: "/unlinked" })).threadId

        yield* AutoArchive.use((autoArchive) => autoArchive.sweep)

        expect(yield* statusOf(allMerged)).toBe("archived")
        expect(yield* statusOf(oneOpen)).toBe("idle")
        expect(yield* statusOf(closed)).toBe("idle")
        expect(yield* statusOf(running)).toBe("running")
        expect(yield* statusOf(unlinked)).toBe("idle")
        expect(pushes).toContainEqual(
          expect.objectContaining({ type: "thread.updated", thread: expect.objectContaining({ id: allMerged }) }),
        )
      }),
    )
  })
})
