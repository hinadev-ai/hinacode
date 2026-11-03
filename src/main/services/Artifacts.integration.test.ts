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
            return yield* artifacts.saveDocument({ id: created.id, baseRevision: created.revision ?? 0, markdown: "Hi" })
          }),
        ),
      )
      expect(saved).toEqual({ type: "saved", version: 1, revision: 2 })
    }),
  )
})
