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

/**
 * Subscribes to one session's `terminal.data` pushes, then runs `write` and collects output until it
 * contains `expected`. Pick text that only the command prints, not the shell's echo of what was typed.
 */
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
  })
})
