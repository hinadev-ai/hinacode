import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { layer, SystemResources } from "./SystemResources.ts"

const root = mkdtempSync(join(tmpdir(), "hinacode-resources-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("SystemResources", () => {
  it.effect("keeps one sample every 5 seconds for the last 10 minutes", () =>
    Effect.gen(function* () {
      const resources = yield* SystemResources
      expect((yield* resources.read([])).samples).toEqual([])

      yield* TestClock.adjust("5 seconds")
      const { samples: firstSamples, memoryTotal } = yield* resources.read([])
      expect(firstSamples).toHaveLength(1)
      const [first] = firstSamples
      expect(first?.cpu).toBeGreaterThanOrEqual(0)
      expect(first?.cpu).toBeLessThanOrEqual(1)
      expect(first?.memoryUsed).toBeGreaterThan(0)
      expect(first?.memoryUsed).toBeLessThanOrEqual(memoryTotal)

      yield* TestClock.adjust("15 minutes")
      const { samples } = yield* resources.read([])
      expect(samples).toHaveLength(120)
      expect((samples.at(-1)?.at ?? 0) - (samples[0]?.at ?? 0)).toBe(119 * 5_000)
    }).pipe(Effect.provide(layer)),
  )

  it.effect("reads a disk once for every path on it and skips a missing path", () =>
    Effect.gen(function* () {
      mkdirSync(join(root, "project"), { recursive: true })
      const { disks } = yield* (yield* SystemResources).read([join(root, "project"), root, join(root, "missing")])
      expect(disks).toEqual([{ path: root, used: expect.any(Number), free: expect.any(Number) }])
      expect(disks[0]?.free).toBeGreaterThan(0)
    }).pipe(Effect.provide(layer)),
  )
})
