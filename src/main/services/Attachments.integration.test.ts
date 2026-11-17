import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

const roots = mkdtempSync(join(tmpdir(), "kk-attachments-"))
afterAll(() => rmSync(roots, { recursive: true, force: true }))

const inFreshRoot = <A, E, R>(test: (root: string, artifactsRoot: string) => Effect.Effect<A, E, R>) => {
  const root = mkdtempSync(join(roots, "root-"))
  const artifactsRoot = mkdtempSync(join(roots, "artifacts-"))
  return test(root, artifactsRoot).pipe(
    Effect.provide(
      Layer.mergeAll(attachmentsLayer(root, { artifactsRoot }), messagesLayer).pipe(
        Layer.provideMerge(Db.layer(":memory:")),
      ),
    ),
  )
}

const stagePng = (threadId: string, name: string) =>
  Attachments.use((attachments) => attachments.stage(threadId, { dataUrl: "data:image/png;base64,iVBORw0KGgo=", name }))

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
    yield* Attachments.use((attachments) => attachments.prune)
  })

describe("Attachments", () => {
  it.effect("deleting a thread deletes the files it staged", () =>
    inFreshRoot((root) =>
      Effect.gen(function* () {
        const { threadId } = yield* seedThread({ rootPath: "/repo" })
        const sent = yield* stagePng(threadId, "sent.png")
        yield* sendWith(threadId, sent)
        const drafted = yield* stagePng(threadId, "drafted.png")

        yield* deleteThread(threadId)

        expect(existsSync(sent.path)).toBe(false)
        expect(existsSync(drafted.path)).toBe(false)
        expect(existsSync(join(root, threadId))).toBe(false)
      }),
    ),
  )

  it.effect("keeps a deleted thread's file while a fork of it still shows that file", () =>
    inFreshRoot((root) =>
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
      }),
    ),
  )

  it.effect("keeps a file a live thread still has queued", () =>
    inFreshRoot(() =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const { threadId: deleted, projectId } = yield* seedThread({ rootPath: "/repo" })
        const { threadId: live } = yield* seedThread({ rootPath: "/repo", projectId })
        const queued = yield* stagePng(deleted, "queued.png")
        const queue = JSON.stringify([{ id: "q", text: "", attachments: [queued] }])
        yield* sql`UPDATE thread SET queue = ${queue} WHERE id = ${live}`

        yield* deleteThread(deleted)

        expect(existsSync(queued.path)).toBe(true)
      }),
    ),
  )

  it.effect("keeps a file that an artifact comment embeds", () =>
    inFreshRoot((_root, artifactsRoot) =>
      Effect.gen(function* () {
        const { threadId } = yield* seedThread({ rootPath: "/repo" })
        const screenshot = yield* stagePng(threadId, "vm-screenshot.png")
        const comments = join(artifactsRoot, "a1")
        mkdirSync(comments)
        const body = `Broken here: ![VM screenshot](<${screenshot.path}>)`
        writeFileSync(join(comments, "feedback.json"), JSON.stringify({ comments: [{ messages: [{ body }] }] }))

        yield* deleteThread(threadId)

        expect(existsSync(screenshot.path)).toBe(true)
      }),
    ),
  )

  it.effect("keeps a file that a saved routine prompt mentions", () =>
    inFreshRoot(() =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const { threadId, projectId } = yield* seedThread({ rootPath: "/repo" })
        const mockup = yield* stagePng(threadId, "mockup.png")
        yield* sql`INSERT INTO routine ${sql.insert({
          id: "r1",
          projectId,
          name: "nightly",
          enabled: 1,
          prompt: `Compare the page with ${mockup.path}`,
          provider: "claude",
          model: "m",
          workspace: "local",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })}`

        yield* deleteThread(threadId)

        expect(existsSync(mockup.path)).toBe(true)
      }),
    ),
  )

  it.effect("deletes nothing while an artifact file cannot be read", () =>
    inFreshRoot((_root, artifactsRoot) =>
      Effect.gen(function* () {
        const { threadId } = yield* seedThread({ rootPath: "/repo" })
        const unsent = yield* stagePng(threadId, "unsent.png")
        const locked = join(artifactsRoot, "feedback.json")
        writeFileSync(locked, "{}")
        chmodSync(locked, 0o000)

        const failed = yield* Effect.flip(deleteThread(threadId))

        expect(failed.message).toContain(locked)
        expect(existsSync(unsent.path)).toBe(true)
        chmodSync(locked, 0o600)
      }),
    ),
  )

  it.effect("sweeps the folders of threads deleted before this release, and leaves live threads alone", () =>
    inFreshRoot((root) =>
      Effect.gen(function* () {
        const { threadId: live } = yield* seedThread({ rootPath: "/repo" })
        const kept = yield* stagePng(live, "kept.png")
        const orphan = join(root, randomUUID())
        mkdirSync(orphan)
        writeFileSync(join(orphan, "left-behind.png"), "")

        yield* Attachments.use((attachments) => attachments.prune)

        expect(existsSync(orphan)).toBe(false)
        expect(existsSync(kept.path)).toBe(true)
      }),
    ),
  )
})
