import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, layer } from "@effect/vitest"
import { Context, Effect, Layer, PubSub } from "effect"
import type { PushEvent } from "../../shared/contract.ts"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import { Events } from "./Events.ts"
import { Terminals, layer as terminalsLayer } from "./Terminals.ts"

class Pushes extends Context.Service<Pushes, PubSub.PubSub<PushEvent>>()("test/Pushes") {}

const pushes = Effect.runSync(PubSub.unbounded<PushEvent>())

const testLayer = terminalsLayer.pipe(
  Layer.provide(Layer.succeed(Events, Events.of({ publish: (event) => Effect.asVoid(PubSub.publish(pushes, event)) }))),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provideMerge(Layer.succeed(Pushes, pushes)),
)

const base = realpathSync(mkdtempSync(join(tmpdir(), "kk-terminals-")))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const gitRepo = (name: string) => {
  const path = join(base, name)
  execFileSync("git", ["init", "-q", "-b", "main", path])
  return path
}

const outputUntil = (id: string, expected: string) =>
  Effect.gen(function* () {
    const updates = yield* PubSub.subscribe(yield* Pushes)
    return (write: Effect.Effect<void, unknown>) =>
      Effect.gen(function* () {
        yield* write
        let output = ""
        while (!output.includes(expected)) {
          const event = yield* PubSub.take(updates)
          if (event.type === "terminal.data" && event.id === id) output += event.data
        }
        return output
      })
  })

const contiguousOutput = (id: string) =>
  Effect.gen(function* () {
    const updates = yield* PubSub.subscribe(yield* Pushes)
    let text = ""
    return (done: (text: string) => boolean) =>
      Effect.gen(function* () {
        while (!done(text)) {
          const event = yield* PubSub.take(updates)
          if (event.type !== "terminal.data" || event.id !== id) continue
          expect(event.offset).toBe(text.length)
          text += event.data
        }
        return text
      })
  })

const SCROLLBACK_BYTES = 256 * 1024

describe("Terminals", () => {
  layer(testLayer)((it) => {
    it.effect(
      "runs a shell in the thread's worktree and pushes its output",
      () =>
        Effect.gen(function* () {
          const worktree = gitRepo("worktree")
          const { threadId } = yield* seedThread({
            rootPath: gitRepo("root"),
            worktree: { path: worktree, baseRef: "main", status: "ready" },
          })
          const terminals = yield* Terminals
          const session = yield* terminals.open({ threadId, cols: 100, rows: 30 })
          expect(session).toMatchObject({ threadId, cwd: worktree, cols: 100, rows: 30, status: "running" })

          const run = yield* outputUntil(session.id, "hi-42")
          yield* run(terminals.write(session.id, "echo hi-$((40 + 2))\n"))

          const size = yield* outputUntil(session.id, "40 120")
          yield* size(
            terminals.resize(session.id, 120, 40).pipe(Effect.andThen(terminals.write(session.id, "stty size\n"))),
          )
          expect(yield* terminals.list(threadId)).toStrictEqual([{ ...session, cols: 120, rows: 40 }])

          yield* terminals.close(session.id)
          expect(yield* terminals.list(threadId)).toStrictEqual([])
          expect(yield* Effect.flip(terminals.write(session.id, "ls\n"))).toMatchObject({ _tag: "NotFoundError" })
        }).pipe(Effect.scoped),
      30_000,
    )

    it.effect(
      "ends every session of a thread and reports each exit",
      () =>
        Effect.gen(function* () {
          const { threadId } = yield* seedThread({ rootPath: gitRepo("project") })
          const terminals = yield* Terminals
          const first = yield* terminals.open({ threadId, cols: 80, rows: 24 })
          const second = yield* terminals.open({ threadId, cols: 80, rows: 24 })
          expect(first.cwd).toBe(join(base, "project"))

          const updates = yield* PubSub.subscribe(yield* Pushes)
          yield* terminals.closeThread(threadId)
          expect(yield* terminals.list(threadId)).toStrictEqual([])

          const running = new Set([first.id, second.id])
          while (running.size > 0) {
            const event = yield* PubSub.take(updates)
            if (event.type === "terminal.exited") running.delete(event.id)
          }
        }).pipe(Effect.scoped),
      30_000,
    )

    it.effect(
      "attaches since an offset, including output still waiting for its push",
      () =>
        Effect.gen(function* () {
          const { threadId } = yield* seedThread({ rootPath: gitRepo("attach") })
          const terminals = yield* Terminals
          const session = yield* terminals.open({ threadId, cols: 80, rows: 24 })
          const output = yield* contiguousOutput(session.id)
          yield* terminals.write(session.id, "echo first-$((1 + 1))\n")
          const before = yield* output((text) => text.includes("first-2"))

          yield* terminals.write(session.id, "echo second-$((2 + 1))\n")
          const since = before.length
          const attached = yield* terminals.attach(session.id, since)
          expect(attached.session).toStrictEqual(session)
          expect(attached.offset).toBe(since)

          const pushed = yield* output(
            (text) => text.length >= since + attached.data.length && text.includes("second-3"),
          )
          expect(pushed.slice(since, since + attached.data.length)).toBe(attached.data)
          const everything = yield* terminals.attach(session.id, null)
          expect(everything.offset).toBe(0)
          expect(everything.data.startsWith(pushed.slice(0, since + attached.data.length))).toBe(true)
        }).pipe(Effect.scoped),
      30_000,
    )

    it.effect(
      "keeps the last 256 KiB of UTF-8 after the scrollback wrapped",
      () =>
        Effect.gen(function* () {
          const { threadId } = yield* seedThread({ rootPath: gitRepo("wrap") })
          const terminals = yield* Terminals
          const session = yield* terminals.open({ threadId, cols: 80, rows: 24 })
          const output = yield* contiguousOutput(session.id)
          const lines = 70_000
          const line = "é\r\n"
          expect(line.length * lines).toBeLessThan(SCROLLBACK_BYTES)
          expect(Buffer.byteLength(line.repeat(lines))).toBeGreaterThan(SCROLLBACK_BYTES)
          yield* terminals.write(session.id, `yes é | head -n ${lines}; echo wrapped-$((1 + 1))\n`)
          yield* output((text) => text.includes("wrapped-2"))

          const attached = yield* terminals.attach(session.id, 0)
          expect(attached.offset).toBeGreaterThan(0)
          expect(Buffer.byteLength(attached.data)).toBeLessThanOrEqual(SCROLLBACK_BYTES)
          expect(Buffer.byteLength(attached.data)).toBeGreaterThan(SCROLLBACK_BYTES - 4)
          const pushed = yield* output((text) => text.length >= attached.offset + attached.data.length)
          expect(pushed.slice(attached.offset, attached.offset + attached.data.length)).toBe(attached.data)
        }).pipe(Effect.scoped),
      30_000,
    )

    it.effect(
      "attaches an exited session until it is closed",
      () =>
        Effect.gen(function* () {
          const { threadId } = yield* seedThread({ rootPath: gitRepo("exited") })
          const terminals = yield* Terminals
          const session = yield* terminals.open({ threadId, cols: 80, rows: 24 })
          const updates = yield* PubSub.subscribe(yield* Pushes)
          yield* terminals.write(session.id, "echo bye-$((3 + 4)); exit 3\n")
          let pushed = ""
          while (true) {
            const event = yield* PubSub.take(updates)
            if (event.type === "terminal.data" && event.id === session.id) pushed += event.data
            if (event.type === "terminal.exited" && event.id === session.id) break
          }
          expect(pushed).toContain("bye-7")

          const attached = yield* terminals.attach(session.id, null)
          expect(attached).toStrictEqual({
            session: { ...session, status: "exited", exitCode: 3 },
            offset: 0,
            data: pushed,
          })

          yield* terminals.close(session.id)
          expect(yield* Effect.flip(terminals.attach(session.id, null))).toMatchObject({ _tag: "NotFoundError" })
        }).pipe(Effect.scoped),
      30_000,
    )
  })
})
