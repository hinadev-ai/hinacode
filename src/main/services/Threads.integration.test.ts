import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
import { makeActiveWorkspace } from "./workspace.ts"
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
      const now = "2026-01-01T00:00:00.000Z"
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

  it.effect("starts chats in conversation mode", () =>
    Effect.gen(function* () {
      const threads = yield* Threads
      const chats = yield* Projects.Projects.use((projects) =>
        projects.ensureChats(mkdtempSync(join(tmpdir(), "kk-chats-"))),
      )
      const { projectId } = yield* seedThread({ rootPath: "/repo" })
      const create = (id: string) => threads.create({ projectId: id, title: "t", provider: "claude", model: "m" })
      expect((yield* create(chats.id)).userSkills).toBe(false)
      expect((yield* create(projectId)).userSkills).toBe(true)
    }).pipe(Effect.provide(threadsLayer)),
  )

  it.effect("gives each chat a folder of its own that lives until the chat is archived", () =>
    Effect.gen(function* () {
      const threads = yield* Threads
      const activeWorkspace = yield* makeActiveWorkspace
      const chats = yield* Projects.Projects.use((projects) =>
        projects.ensureChats(mkdtempSync(join(tmpdir(), "kk-chats-"))),
      )
      const create = () => threads.create({ projectId: chats.id, title: "t", provider: "claude", model: "m" })
      const [first, second] = [yield* create(), yield* create()]
      const [{ cwd }, other] = [yield* activeWorkspace(first.id), yield* activeWorkspace(second.id)]
      expect(cwd).not.toBe(other.cwd)
      expect(existsSync(cwd)).toBe(true)
      writeFileSync(join(cwd, "notes.md"), "draft")

      yield* threads.archive(first.id)
      expect(existsSync(cwd)).toBe(false)
      yield* threads.unarchive(first.id)
      expect(existsSync(cwd)).toBe(true)
      expect(existsSync(join(cwd, "notes.md"))).toBe(false)

      yield* threads.remove(second.id)
      expect(existsSync(other.cwd)).toBe(false)
    }).pipe(Effect.provide(threadsLayer)),
  )
})
