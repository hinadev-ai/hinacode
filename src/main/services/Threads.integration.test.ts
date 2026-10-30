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
import { Messages, layer as messagesLayer } from "./Messages.ts"
import * as Projects from "./Projects.ts"
import * as Settings from "./Settings.ts"
import * as Terminals from "./Terminals.ts"
import { layer as threadsLayerBase, Threads } from "./Threads.ts"
import { makeActiveWorkspace } from "./workspace.ts"
import * as Worktrees from "./Worktrees.ts"
import * as Scratch from "./Scratch.ts"

const threadsLayer = threadsLayerBase.pipe(
  Layer.provideMerge(Scratch.layer(mkdtempSync(join(tmpdir(), "kk-scratch-")))),
  Layer.provideMerge(Terminals.layer),
  Layer.provideMerge(Worktrees.layer),
  Layer.provideMerge(Projects.layer),
  Layer.provideMerge(AgentAccounts.layer),
  Layer.provideMerge(Settings.layer(mkdtempSync(join(tmpdir(), "kk-threads-settings-")))),
  Layer.provide(
    Layer.mergeAll(Git.layer, GitHub.layer).pipe(
      Layer.provideMerge(Layer.succeed(Events, { publish: () => Effect.void })),
    ),
  ),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(NodeServices.layer),
)

describe("Threads", () => {
  it.effect("forks a thread in its workspace with the transcript up to the chosen turn", () =>
    Effect.gen(function* () {
      const threads = yield* Threads
      const messages = yield* Messages
      const { threadId, worktreeId } = yield* seedThread({
        rootPath: "/repo",
        worktree: { path: "/repo-feature", baseRef: "main", status: "ready" },
      })
      const at = "2026-01-01T00:00:00.000Z"
      const message = (role: "user" | "assistant", text: string, checkpoint: string | null) => ({
        id: randomUUID(),
        threadId,
        role,
        parts: [{ type: "text" as const, text }],
        createdAt: at,
        completedAt: at,
        usage: null,
        forkPoint: checkpoint === null ? null : { sessionId: "session-1", checkpoint },
      })
      const turns = [
        message("user", "first", null),
        message("assistant", "first reply", "turn-1"),
        message("user", "second", null),
        message("assistant", "second reply", "turn-2"),
      ]
      yield* Effect.forEach(turns, messages.insert, { discard: true })

      const fork = yield* threads.fork(threadId, turns[1]!.id)

      expect(fork.worktreeId).toBe(worktreeId)
      expect(fork.providerSessionId).toBeNull()
      expect(fork.forkedFrom).toStrictEqual({ sessionId: "session-1", checkpoint: "turn-1" })
      expect((yield* threads.get(fork.id)).forkedFrom).toStrictEqual(fork.forkedFrom)
      const copied = yield* messages.list(fork.id)
      expect(copied.map((copy) => copy.parts)).toStrictEqual(turns.slice(0, 2).map((turn) => turn.parts))
      expect(copied.some((copy) => turns.some((turn) => turn.id === copy.id))).toBe(false)
      expect((yield* messages.list(threadId)).length).toBe(4)
    }).pipe(Effect.provide(messagesLayer.pipe(Layer.provideMerge(threadsLayer)))),
  )

  it.effect("refuses to fork at a message that ended no turn", () =>
    Effect.gen(function* () {
      const threads = yield* Threads
      const { threadId } = yield* seedThread({ rootPath: "/repo" })
      const error = yield* threads.fork(threadId, "missing").pipe(Effect.flip)
      expect(error._tag).toBe("NotFoundError")
    }).pipe(Effect.provide(threadsLayer)),
  )

  it.effect("refuses to fork a turn another agent ran", () =>
    Effect.gen(function* () {
      const threads = yield* Threads
      const messages = yield* Messages
      const { threadId } = yield* seedThread({ rootPath: "/repo" })
      const at = "2026-01-01T00:00:00.000Z"
      const reply = {
        id: randomUUID(),
        threadId,
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: "from codex" }],
        createdAt: at,
        completedAt: at,
        usage: null,
        forkPoint: {
          sessionId: "codex-thread",
          checkpoint: "turn-1",
          owner: { provider: "codex" as const, accountId: null },
        },
      }
      yield* messages.insert(reply)
      const before = (yield* threads.list).length

      const error = yield* threads.fork(threadId, reply.id).pipe(Effect.flip)

      expect(error._tag).toBe("NotFoundError")
      expect((yield* threads.list).length).toBe(before)
    }).pipe(Effect.provide(messagesLayer.pipe(Layer.provideMerge(threadsLayer)))),
  )

  it.effect("keeps one side chat per thread in its workspace, out of the list", () =>
    Effect.gen(function* () {
      const threads = yield* Threads
      const activeWorkspace = yield* makeActiveWorkspace
      const { threadId, worktreeId } = yield* seedThread({
        rootPath: "/repo",
        worktree: { path: "/repo-feature", baseRef: "main", status: "ready" },
      })

      const [side, again] = yield* Effect.all([threads.sidechat(threadId), threads.sidechat(threadId)], {
        concurrency: "unbounded",
      })

      expect(again.id).toBe(side.id)
      expect(side).toMatchObject({ sideOf: threadId, worktreeId, accessMode: "supervised", forkedFrom: null })
      expect((yield* activeWorkspace(side.id)).cwd).toBe("/repo-feature")
      expect((yield* threads.list).map((thread) => thread.id)).toStrictEqual([threadId])

      yield* threads.remove(threadId)
      expect((yield* threads.get(side.id).pipe(Effect.flip))._tag).toBe("NotFoundError")
    }).pipe(Effect.provide(threadsLayer)),
  )

  it.effect("rebases an unstarted side chat on its parent's agent and latest fork point", () =>
    Effect.gen(function* () {
      const threads = yield* Threads
      const { threadId } = yield* seedThread({ rootPath: "/repo" })
      const side = yield* threads.update({ id: (yield* threads.sidechat(threadId)).id, model: "faster" })
      const forkPoint = {
        sessionId: "session-1",
        checkpoint: "turn-1",
        owner: { provider: "claude", accountId: null },
      } as const

      const rebased = yield* threads.rebaseSidechat(side.id, yield* threads.get(threadId), forkPoint)
      expect(rebased.model).toBe("faster")
      expect(rebased.forkedFrom).toStrictEqual({ sessionId: "session-1", checkpoint: "turn-1" })
      expect(yield* threads.get(side.id)).toStrictEqual(rebased)

      const parent = yield* threads.update({ id: threadId, provider: "codex", model: "codex-model" })
      expect(yield* threads.rebaseSidechat(side.id, parent, null)).toMatchObject({
        provider: "codex",
        model: "codex-model",
        forkedFrom: null,
      })
    }).pipe(Effect.provide(threadsLayer)),
  )

  it.effect("lets a thread give up its worktree while its side chat is open", () =>
    Effect.gen(function* () {
      const threads = yield* Threads
      const worktrees = yield* Worktrees.Worktrees
      const { threadId, worktreeId } = yield* seedThread({
        rootPath: "/repo",
        worktree: { path: "/repo-feature", baseRef: "main", status: "ready" },
      })
      yield* threads.sidechat(threadId)
      const removed = yield* worktrees.remove(worktreeId!, "force", threadId)
      expect(removed.status).toBe("removed")
    }).pipe(Effect.provide(threadsLayer)),
  )

  it.effect("runs a chat's side chat in the chat's own folder", () =>
    Effect.gen(function* () {
      const threads = yield* Threads
      const activeWorkspace = yield* makeActiveWorkspace
      const chats = yield* Projects.Projects.use((projects) =>
        projects.ensureChats(mkdtempSync(join(tmpdir(), "kk-chats-"))),
      )
      const chat = yield* threads.create({ projectId: chats.id, title: "t", provider: "claude", model: "m" })
      const side = yield* threads.sidechat(chat.id)
      expect((yield* activeWorkspace(side.id)).cwd).toBe((yield* activeWorkspace(chat.id)).cwd)
    }).pipe(Effect.provide(threadsLayer)),
  )

  it.effect("list skips threads whose provider this build does not know", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const threads = yield* Threads
      const { projectId, threadId } = yield* seedThread({ rootPath: "/repo" })
      const now = "2026-01-01T00:00:00.000Z"
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

  it.effect("deletes a thread's scratch folder when it is archived or deleted", () =>
    Effect.gen(function* () {
      const threads = yield* Threads
      const scratch = yield* Scratch.Scratch
      const archived = yield* threads.get((yield* seedThread({ rootPath: "/repo" })).threadId)
      const deleted = yield* threads.get((yield* seedThread({ rootPath: "/other" })).threadId)
      const [archivedFolder, deletedFolder] = [yield* scratch.ensure(archived), yield* scratch.ensure(deleted)]
      writeFileSync(join(archivedFolder, "experiment.py"), "print(1)")

      yield* threads.archive(archived.id)
      expect(existsSync(archivedFolder)).toBe(false)
      expect(existsSync(deletedFolder)).toBe(true)

      yield* threads.remove(deleted.id)
      expect(existsSync(deletedFolder)).toBe(false)
      yield* threads.remove(archived.id)
    }).pipe(Effect.provide(threadsLayer)),
  )
})
