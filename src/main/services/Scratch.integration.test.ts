import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Logger } from "effect"
import * as Scratch from "./Scratch.ts"

const dir = mkdtempSync(join(tmpdir(), "kk-scratch-tmp-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const withScratch = <A, E>(
  effect: Effect.Effect<A, E, Scratch.Scratch>,
  root: string,
  options?: Parameters<typeof Scratch.layer>[1],
) => effect.pipe(Effect.provide(Scratch.layer(root, options).pipe(Layer.provide(NodeServices.layer))))

const ensureTmpLogging = (threadId: string, tmpRoot: string) => {
  const warnings: Array<string> = []
  return withScratch(
    Effect.gen(function* () {
      const scratch = yield* Scratch.Scratch
      return { folder: yield* scratch.ensureTmp(threadId), warnings }
    }),
    mkdtempSync(join(dir, "data-")),
    { tmpRoot },
  ).pipe(Effect.provide(Logger.layer([Logger.make(({ message }) => warnings.push(String(message)))])))
}

describe("thread tmp folders", () => {
  it.effect("keeps a thread's tmp folder path short enough for Unix sockets inside it", () =>
    Effect.gen(function* () {
      const threadId = randomUUID()
      const folder = String(
        yield* withScratch(
          Scratch.Scratch.use((scratch) => scratch.ensureTmp(threadId)),
          join(dir, "a"),
        ),
      )
      try {
        expect(dirname(dirname(folder))).toBe(tmpdir())
        expect(folder).toMatch(new RegExp(`/hc-[0-9a-f]{6}/${threadId.slice(0, 8)}$`))
        expect(folder.length - tmpdir().length).toBeLessThanOrEqual(20)
        expect(lstatSync(dirname(folder)).mode & 0o777).toBe(0o700)
      } finally {
        rmSync(dirname(folder), { recursive: true, force: true })
      }
    }),
  )

  it.effect("keeps another data dir's folder for the same thread when one removes its own", () =>
    Effect.gen(function* () {
      const threadId = randomUUID()
      const ensure = (root: string) =>
        withScratch(
          Scratch.Scratch.use((scratch) => scratch.ensureTmp(threadId)),
          root,
        ).pipe(Effect.map(String))
      const remove = (root: string) =>
        withScratch(
          Scratch.Scratch.use((scratch) => scratch.remove(threadId)),
          root,
        )
      const [real, copy] = [join(dir, "real"), join(dir, "copy")]
      const [realTmp, copyTmp] = [yield* ensure(real), yield* ensure(copy)]
      try {
        expect(realTmp).not.toBe(copyTmp)
        yield* remove(copy)
        expect(existsSync(copyTmp)).toBe(false)
        expect(existsSync(realTmp)).toBe(true)
      } finally {
        for (const folder of [realTmp, copyTmp]) rmSync(dirname(folder), { recursive: true, force: true })
      }
    }),
  )

  it.effect("uses no tmp folder, with a warning, when its root is a symlink", () =>
    Effect.gen(function* () {
      const target = mkdtempSync(join(dir, "someone-else-"))
      const tmpRoot = join(dir, "linked-root")
      symlinkSync(target, tmpRoot)
      const { folder, warnings } = yield* ensureTmpLogging(randomUUID(), tmpRoot)
      expect(folder).toBeNull()
      expect(warnings.some((message) => message.includes("not a private folder"))).toBe(true)
      expect(readdirSync(target)).toStrictEqual([])
    }),
  )

  it.effect.skipIf(process.platform === "win32")(
    "uses no tmp folder, with a warning, when others can write to its root",
    () =>
      Effect.gen(function* () {
        const tmpRoot = join(dir, "shared-root")
        mkdirSync(tmpRoot)
        chmodSync(tmpRoot, 0o777)
        const { folder, warnings } = yield* ensureTmpLogging(randomUUID(), tmpRoot)
        expect(folder).toBeNull()
        expect(warnings.some((message) => message.includes("not a private folder"))).toBe(true)
        expect(readdirSync(tmpRoot)).toStrictEqual([])
      }),
  )
})
