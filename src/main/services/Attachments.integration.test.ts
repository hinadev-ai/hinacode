import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import type { Attachment } from "../../shared/domain.ts"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import { Attachments, layer as attachmentsLayer } from "./Attachments.ts"
import { Messages, layer as messagesLayer } from "./Messages.ts"

const root = mkdtempSync(join(tmpdir(), "kk-attachments-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const testLayer = Layer.mergeAll(attachmentsLayer(root), messagesLayer).pipe(Layer.provideMerge(Db.layer(":memory:")))

const stagePng = (threadId: string, name: string) =>
  Attachments.use((attachments) =>
    attachments.stage(threadId, { dataUrl: "data:image/png;base64,iVBORw0KGgo=", name }),
  )

const sendWith = (threadId: string, attachment: Attachment) =>
  Messages.use((messages) =>
    messages.insert({
      id: randomUUID(),
      threadId,
      role: "user",
      parts: [{ type: "attachment", attachment }],
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.000Z",
      usage: null,
      forkPoint: null,
    }),
  )

const deleteThread = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DELETE FROM thread WHERE id = ${threadId}`
    yield* Attachments.use((attachments) => attachments.release(threadId))
  })

describe("Attachments", () => {
  it.effect("deleting a thread deletes the files it staged", () =>
    Effect.gen(function* () {
      const { threadId } = yield* seedThread({ rootPath: "/repo" })
      const sent = yield* stagePng(threadId, "sent.png")
      yield* sendWith(threadId, sent)
      const drafted = yield* stagePng(threadId, "drafted.png")

      yield* deleteThread(threadId)

      expect(existsSync(sent.path)).toBe(false)
      expect(existsSync(drafted.path)).toBe(false)
      expect(existsSync(join(root, threadId))).toBe(false)
    }).pipe(Effect.provide(testLayer)),
  )

  it.effect("keeps a deleted thread's file while a fork of it still shows that file", () =>
    Effect.gen(function* () {
      const { threadId: parent, projectId } = yield* seedThread({ rootPath: "/repo" })
      const { threadId: fork } = yield* seedThread({ rootPath: "/repo", projectId })
      const shared = yield* stagePng(parent, "shared.png")
      const parentOnly = yield* stagePng(parent, "parent-only.png")
      yield* sendWith(parent, shared)
      yield* sendWith(parent, parentOnly)
      yield* sendWith(fork, shared)

      yield* deleteThread(parent)

      expect(existsSync(shared.path)).toBe(true)
      expect(existsSync(parentOnly.path)).toBe(false)

      yield* deleteThread(fork)

      expect(existsSync(shared.path)).toBe(false)
      expect(existsSync(join(root, parent))).toBe(false)
    }).pipe(Effect.provide(testLayer)),
  )

  it.effect("keeps a file a live thread still has queued", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const { threadId: deleted, projectId } = yield* seedThread({ rootPath: "/repo" })
      const { threadId: live } = yield* seedThread({ rootPath: "/repo", projectId })
      const queued = yield* stagePng(deleted, "queued.png")
      const queue = JSON.stringify([{ id: "q", text: "", attachments: [queued] }])
      yield* sql`UPDATE thread SET queue = ${queue} WHERE id = ${live}`

      yield* deleteThread(deleted)

      expect(existsSync(queued.path)).toBe(true)
    }).pipe(Effect.provide(testLayer)),
  )

  it.effect("sweeps the folders of threads deleted before this release, and leaves live threads alone", () =>
    Effect.gen(function* () {
      const { threadId: live } = yield* seedThread({ rootPath: "/repo" })
      const kept = yield* stagePng(live, "kept.png")
      const orphan = join(root, randomUUID())
      mkdirSync(orphan)
      writeFileSync(join(orphan, "left-behind.png"), "")

      yield* Attachments.use((attachments) => attachments.releaseOrphans)

      expect(existsSync(orphan)).toBe(false)
      expect(existsSync(kept.path)).toBe(true)
    }).pipe(Effect.provide(testLayer)),
  )
})
