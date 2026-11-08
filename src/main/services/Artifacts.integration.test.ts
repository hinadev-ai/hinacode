import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { openArtifactStore } from "@hinacode/artifacts"
import { Effect, Layer, Queue } from "effect"
import type { PushEvent } from "../../shared/contract.ts"
import { Artifacts, layer } from "./Artifacts.ts"
import { Events } from "./Events.ts"

const withArtifacts = <A, E>(root: string, use: (pushes: Queue.Queue<PushEvent>) => Effect.Effect<A, E, Artifacts>) =>
  Effect.gen(function* () {
    const pushes = yield* Queue.unbounded<PushEvent>()
    const events = Layer.succeed(Events, { publish: (event) => Queue.offer(pushes, event).pipe(Effect.asVoid) })
    return yield* use(pushes).pipe(Effect.provide(layer(root).pipe(Layer.provide(events))))
  })

const page = (title: string, html: string) => ({ title, files: [{ path: "index.html", content: html }] })

describe("Artifacts", () => {
  it.live("pushes artifact.updated when anyone writes a manifest, once per version", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "kk-artifacts-"))
      const elsewhere = openArtifactStore(root)
      const existing = yield* Effect.promise(() => elsewhere.publish(page("Before", "<p>old</p>")))

      const updates = yield* withArtifacts(root, (pushes) =>
        Effect.gen(function* () {
          const first = yield* Effect.promise(() => elsewhere.publish(page("Report", "<p>1</p>")))
          const pushed = [yield* Queue.take(pushes)]
          yield* Effect.promise(() => elsewhere.publish({ ...page("Report", "<p>2</p>"), id: first.id }))
          pushed.push(yield* Queue.take(pushes))
          yield* Effect.sleep("200 millis")
          return [...pushed, ...(yield* Queue.clear(pushes))]
        }),
      )

      expect(
        updates.map((event) => event.type === "artifact.updated" && [event.artifact.title, event.artifact.version]),
      ).toEqual([
        ["Report", 1],
        ["Report", 2],
      ])
      expect(updates.some((event) => event.type === "artifact.updated" && event.artifact.id === existing.id)).toBe(
        false,
      )
    }),
  )

  it.live("pushes artifact.feedback when anyone writes an artifact's feedback", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "kk-artifacts-"))
      const elsewhere = openArtifactStore(root)
      const document = yield* Effect.promise(() => elsewhere.publish({ kind: "document", title: "Plan", markdown: "" }))

      const pushed = yield* withArtifacts(root, (pushes) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => elsewhere.comment(document.id, { author: { kind: "agent" }, body: "Ready?" }))
          const first = yield* Queue.take(pushes)
          yield* Effect.sleep("200 millis")
          return [first, ...(yield* Queue.clear(pushes))]
        }),
      )

      expect(pushed).toEqual([{ type: "artifact.feedback", id: document.id }])
    }),
  )

  it.live("saves the developer's whiteboard and answers a stale save with the current scene", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "kk-artifacts-"))
      const board = yield* Effect.promise(() =>
        openArtifactStore(root).publish({
          kind: "whiteboard",
          title: "Board",
          patch: { upsert: [{ id: "api", type: "rectangle" }] },
        }),
      )
      const [read, saved, stale, missing] = yield* withArtifacts(root, () =>
        Artifacts.use((artifacts) =>
          Effect.gen(function* () {
            const current = yield* artifacts.readWhiteboard(board.id)
            const scene = { elements: [...current.scene.elements, { id: "db", type: "ellipse" }] }
            return [
              current,
              yield* artifacts.saveWhiteboard({ id: board.id, baseRevision: current.revision, scene }),
              yield* artifacts.saveWhiteboard({
                id: board.id,
                baseRevision: current.revision,
                scene: { elements: [] },
              }),
              yield* Effect.flip(artifacts.readWhiteboard("gone")),
            ] as const
          }),
        ),
      )

      expect(read).toEqual({
        version: 1,
        revision: 1,
        scene: { elements: [{ id: "api", type: "rectangle" }], files: {} },
      })
      expect(saved).toEqual({ type: "saved", version: 2, revision: 2 })
      expect(stale).toEqual({
        type: "conflict",
        version: 2,
        revision: 2,
        scene: {
          elements: [
            { id: "api", type: "rectangle" },
            { id: "db", type: "ellipse" },
          ],
          files: {},
        },
      })
      expect(missing._tag).toBe("NotFoundError")
    }),
  )

  it.live("previews the entry for an empty path and fails for an unknown file", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "kk-artifacts-"))
      const { id } = yield* Effect.promise(() => openArtifactStore(root).publish(page("Hello", "<h1>hi</h1>")))
      const [entry, missing] = yield* withArtifacts(root, () =>
        Artifacts.use((artifacts) =>
          Effect.all([artifacts.preview(id, ""), Effect.flip(artifacts.preview(id, "gone.html"))]),
        ),
      )
      expect(entry.dataUrl).toBe(`data:text/html;charset=utf-8;base64,${Buffer.from("<h1>hi</h1>").toString("base64")}`)
      expect(missing._tag).toBe("NotFoundError")
    }),
  )

  it.live("pushes artifact.removed once, whether HinaCode or another harness deletes it", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "kk-artifacts-"))
      const elsewhere = openArtifactStore(root)
      const ours = yield* Effect.promise(() => elsewhere.publish(page("Ours", "<p>1</p>")))
      const theirs = yield* Effect.promise(() => elsewhere.publish(page("Theirs", "<p>2</p>")))

      const [removals, missing] = yield* withArtifacts(root, (pushes) =>
        Effect.gen(function* () {
          yield* Artifacts.use((artifacts) => artifacts.remove(ours.id))
          yield* Effect.promise(() => elsewhere.remove(theirs.id))
          const pushed = [yield* Queue.take(pushes), yield* Queue.take(pushes)]
          yield* Effect.sleep("200 millis")
          const missing = yield* Effect.flip(Artifacts.use((artifacts) => artifacts.remove(ours.id)))
          return [[...pushed, ...(yield* Queue.clear(pushes))], missing] as const
        }),
      )

      expect(removals).toEqual([
        { type: "artifact.removed", id: ours.id },
        { type: "artifact.removed", id: theirs.id },
      ])
      expect(missing._tag).toBe("NotFoundError")
    }),
  )

  it.live("keeps a document the developer created in one version while they edit it", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "kk-artifacts-"))
      const saved = yield* withArtifacts(root, () =>
        Artifacts.use((artifacts) =>
          Effect.gen(function* () {
            const created = yield* artifacts.createDocument({ threadId: "t-1", title: "Untitled" })
            return yield* artifacts.saveDocument({
              id: created.id,
              baseRevision: created.revision ?? 0,
              markdown: "Hi",
            })
          }),
        ),
      )
      expect(saved).toEqual({ type: "saved", version: 1, revision: 2 })
    }),
  )

  it.live("creates an empty whiteboard for the developer, and the first drawing saves in the same version", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "kk-artifacts-"))
      const [created, pushed, empty, saved] = yield* withArtifacts(root, (pushes) =>
        Artifacts.use((artifacts) =>
          Effect.gen(function* () {
            const board = yield* artifacts.createWhiteboard({ threadId: "t-1", title: "Untitled" })
            const current = yield* artifacts.readWhiteboard(board.id)
            return [
              board,
              yield* Queue.take(pushes),
              current,
              yield* artifacts.saveWhiteboard({
                id: board.id,
                baseRevision: current.revision,
                scene: { elements: [{ id: "box", type: "rectangle" }] },
              }),
            ] as const
          }),
        ),
      )

      expect(created).toMatchObject({
        kind: "whiteboard",
        title: "Untitled",
        author: "developer",
        threadId: "t-1",
        entry: "scene.excalidraw",
      })
      expect(pushed).toEqual({ type: "artifact.updated", artifact: created })
      expect(empty).toEqual({ version: 1, revision: 1, scene: { elements: [], files: {} } })
      expect(saved).toEqual({ type: "saved", version: 1, revision: 2 })
    }),
  )

  it.live("stores a pasted image from a data URL and serves it as a document file", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "kk-artifacts-"))
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
      const [served, invalid, unknown] = yield* withArtifacts(root, () =>
        Artifacts.use((artifacts) =>
          Effect.gen(function* () {
            const { id } = yield* artifacts.createDocument({ threadId: "t-1", title: "Untitled" })
            const dataUrl = `data:image/png;base64,${png.toString("base64")}`
            const { path } = yield* artifacts.addDocumentImage({ id, dataUrl })
            return [
              yield* artifacts.file(id, path),
              yield* Effect.flip(artifacts.addDocumentImage({ id, dataUrl: "not a data url" })),
              yield* Effect.flip(artifacts.addDocumentImage({ id: "gone", dataUrl })),
            ] as const
          }),
        ),
      )
      expect(served?.bytes).toEqual(png)
      expect(served?.type).toBe("image/png")
      expect(invalid._tag).toBe("DocumentImageError")
      expect(unknown._tag).toBe("NotFoundError")
    }),
  )
})
