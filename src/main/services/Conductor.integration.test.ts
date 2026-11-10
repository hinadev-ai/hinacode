import { mkdtempSync } from "node:fs"
import * as SourceControl from "./SourceControl.ts"
import { tmpdir } from "node:os"
import { describe, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import type { PullRequest, PullRequestStatus } from "../../shared/domain.ts"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import * as AgentAccounts from "./AgentAccounts.ts"
import * as Conductor from "./Conductor.ts"
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

const gitHub = Layer.mock(GitHub, {
  installed: Effect.succeed(true),
  pullRequest: () => Effect.succeed({ url, status } as PullRequest),
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
  Layer.provideMerge(SourceControl.layer),
  Layer.provideMerge(Layer.mergeAll(Git.layer, gitHub)),
  Layer.provide(Layer.succeed(Events, { publish: () => Effect.void })),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(NodeServices.layer),
)

describe("Conductor", () => {
  layer(testLayer)((it) => {
    it.effect("records a linked pull request at once, then its merge on the next sweep", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const observed = sql<{ readonly observedStatus: string | null }>`SELECT observed_status FROM pull_request_link`
        const { threadId } = yield* seedThread({ rootPath: mkdtempSync(`${tmpdir()}/kk-conductor-repo-`) })
        yield* PullRequests.use((pullRequests) => pullRequests.link(threadId, url))
        yield* observed.pipe(Effect.repeat({ until: ([row]) => row?.observedStatus === "open" }))

        status = "merged"
        yield* TestClock.adjust("3 minutes")
        yield* observed.pipe(Effect.repeat({ until: ([row]) => row?.observedStatus === "merged" }))
      }),
    )
  })
})
