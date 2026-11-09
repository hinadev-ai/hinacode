import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { type ArtifactInspection, ArtifactInspector, layerWith } from "./ArtifactInspector.ts"

const inspection: ArtifactInspection = {
  errors: [],
  pageWidth: 400,
  pastTheEdge: [],
  screenshot: { data: new Uint8Array(), mimeType: "image/jpeg" },
}

const letFibersRun = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true })

describe("ArtifactInspector", () => {
  it.effect("renders at most two pages at a time however many publishes arrive together", () => {
    const open: Array<() => void> = []
    let rendering = 0
    let most = 0
    const inspectPage = () =>
      new Promise<ArtifactInspection>((resolve) => {
        rendering += 1
        most = Math.max(most, rendering)
        open.push(() => {
          rendering -= 1
          resolve(inspection)
        })
      })

    return Effect.gen(function* () {
      const inspector = yield* ArtifactInspector
      const publishes = yield* Effect.forEach(
        ["a", "b", "c", "d", "e", "f"],
        (id) => inspector.inspect(id, "index.html"),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild)

      yield* letFibersRun
      expect(rendering).toBe(2)

      while (open.length > 0) {
        for (const close of open.splice(0)) close()
        yield* letFibersRun
      }
      const results = yield* Fiber.join(publishes)

      expect(results).toEqual(Array.from({ length: 6 }, () => inspection))
      expect(most).toBe(2)
    }).pipe(Effect.provide(layerWith(inspectPage)))
  })
})
