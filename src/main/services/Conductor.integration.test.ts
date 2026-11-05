import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { describe, expect, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Fiber, Layer, Queue } from "effect"
import { TestClock } from "effect/testing"
import type { PullRequest, PullRequestStatus } from "../../shared/domain.ts"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import * as AgentAccounts from "./AgentAccounts.ts"
import { Automations } from "./automations/Automations.ts"
import * as Conductor from "./Conductor.ts"
import type { PullRequestEvent } from "./EventBus.ts"
import { Events } from "./Events.ts"
import * as Git from "./Git.ts"
import { GitHub } from "./GitHub.ts"
import * as Projects from "./Projects.ts"
import * as PullRequestLifecycle from "./PullRequestLifecycle.ts"
import { PullRequests, layer as pullRequestsLayer } from "./PullRequests.ts"
import * as Scratch from "./Scratch.ts"
import * as Settings from "./Settings.ts"
import * as Terminals from "./Terminals.ts"
import { layer as threadsLayer } from "./Threads.ts"
import * as Worktrees from "./Worktrees.ts"

const url = "https://github.com/o/r/pull/1"
let status: PullRequestStatus = "open"
const fired = Effect.runSync(Queue.unbounded<PullRequestEvent>())

const gitHub = Layer.mock(GitHub, {
  pullRequest: () => Effect.succeed({ url, status } as PullRequest),
  pullRequestOpenedAt: () => Effect.succeed("2999-01-01T00:00:00.000Z"),
})

const automations = Layer.mock(Automations, {
  firePullRequest: (event) => Queue.offer(fired, event).pipe(Effect.asVoid),
})

const domain = threadsLayer.pipe(
  Layer.provideMerge(Scratch.layer(mkdtempSync(`${tmpdir()}/kk-conductor-scratch-`))),
  Layer.provideMerge(Terminals.layer),
  Layer.provideMerge(Worktrees.layer),
  Layer.provideMerge(Projects.layer),
  Layer.provide(AgentAccounts.layer),
  Layer.provideMerge(Settings.layer(mkdtempSync(`${tmpdir()}/kk-conductor-settings-`))),
)
const testLayer = Conductor.layer.pipe(
  Layer.provideMerge(PullRequestLifecycle.layer),
  Layer.provideMerge(pullRequestsLayer),
  Layer.provideMerge(domain),
  Layer.provide(Layer.mergeAll(Git.layer, gitHub, automations)),
  Layer.provide(Layer.succeed(Events, { publish: () => Effect.void })),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(NodeServices.layer),
)

describe("Conductor", () => {
  layer(testLayer)((it) => {
    it.effect("carries a pull request from link to opened, then to merged on the next sweep", () =>
      Effect.gen(function* () {
        const { threadId } = yield* seedThread({ rootPath: mkdtempSync(`${tmpdir()}/kk-conductor-repo-`) })
        yield* PullRequests.use((pullRequests) => pullRequests.link(threadId, url))
        expect((yield* Queue.take(fired)).topic).toBe("pullRequest.opened")

        status = "merged"
        const merged = yield* Queue.take(fired).pipe(Effect.forkChild)
        yield* TestClock.adjust("3 minutes")
        const event = yield* Fiber.join(merged)
        expect(event).toMatchObject({ topic: "pullRequest.merged", threadId, pullRequest: { url } })
      }),
    )
  })
})
