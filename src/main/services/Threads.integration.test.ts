import { randomUUID } from "node:crypto"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import * as AgentAccounts from "./AgentAccounts.ts"
import { Events } from "./Events.ts"
import * as Git from "./Git.ts"
import * as GitHub from "./GitHub.ts"
import * as Projects from "./Projects.ts"
import * as Settings from "./Settings.ts"
import * as Terminals from "./Terminals.ts"
import { layer as threadsLayerBase, Threads } from "./Threads.ts"
import * as Worktrees from "./Worktrees.ts"

const threadsLayer = threadsLayerBase.pipe(
  Layer.provideMerge(Terminals.layer),
  Layer.provideMerge(Worktrees.layer),
  Layer.provideMerge(Projects.layer),
  Layer.provideMerge(AgentAccounts.layer),
  Layer.provideMerge(Settings.layer),
  Layer.provide(Layer.mergeAll(Git.layer, GitHub.layer, Layer.succeed(Events, { publish: () => Effect.void }))),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(NodeServices.layer),
)

describe("Threads", () => {
  it.effect("list skips threads whose provider this build does not know", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const threads = yield* Threads
      const { projectId, threadId } = yield* seedThread({ rootPath: "/repo" })
      const now = new Date().toISOString()
      // A database written by a newer build: its thread table allows providers this build has no
      // agent for. Listing must degrade to the threads it can run, not fail as a whole.
      yield* sql`PRAGMA ignore_check_constraints = ON`
      yield* sql`INSERT INTO thread ${sql.insert({
        id: randomUUID(),
        projectId,
        worktreeId: null,
        title: "from a newer build",
        provider: "future-agent",
        model: "future-model",
        status: "idle",
        sortIndex: 1,
        createdAt: now,
        updatedAt: now,
      })}`
      yield* sql`PRAGMA ignore_check_constraints = OFF`
      const listed = yield* threads.list
      expect(listed.map((thread) => thread.id)).toStrictEqual([threadId])
    }).pipe(Effect.provide(threadsLayer)),
  )
})
