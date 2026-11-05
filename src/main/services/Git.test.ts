import { describe, expect, it, test } from "@effect/vitest"
import { Effect, Fiber, Layer, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { Git, layer, parseLog } from "./Git.ts"

const record = (...fields: Array<string>) => fields.map((field) => `${field}\0`).join("")

describe("parseLog", () => {
  test("reads a merge, its decorations, and a root commit", () => {
    const output =
      record(
        "c3",
        "c2 b1",
        "Kalan",
        "2026-10-12T10:00:00+09:00",
        "HEAD -> main, origin/main, tag: v1",
        "Merge branch 'feat/x'",
      ) +
      record("b1", "c1", "Agent", "2026-10-11T09:00:00+09:00", "feat/x", "feat(x): add x") +
      record("c2", "c1", "Kalan", "2026-10-11T08:00:00+09:00", "", "fix: a, b -> c") +
      record("c1", "", "Kalan", "2026-10-10T08:00:00+09:00", "", "init")

    expect(parseLog(output)).toStrictEqual([
      {
        hash: "c3",
        parents: ["c2", "b1"],
        subject: "Merge branch 'feat/x'",
        author: "Kalan",
        authoredAt: "2026-10-12T10:00:00+09:00",
        refs: ["HEAD", "main", "origin/main", "tag: v1"],
      },
      {
        hash: "b1",
        parents: ["c1"],
        subject: "feat(x): add x",
        author: "Agent",
        authoredAt: "2026-10-11T09:00:00+09:00",
        refs: ["feat/x"],
      },
      {
        hash: "c2",
        parents: ["c1"],
        subject: "fix: a, b -> c",
        author: "Kalan",
        authoredAt: "2026-10-11T08:00:00+09:00",
        refs: [],
      },
      {
        hash: "c1",
        parents: [],
        subject: "init",
        author: "Kalan",
        authoredAt: "2026-10-10T08:00:00+09:00",
        refs: [],
      },
    ])
  })

  test("a detached HEAD is its own ref, and an empty repository has no commits", () => {
    expect(parseLog(record("a1", "", "K", "2026-10-10T08:00:00Z", "HEAD", "wip"))[0]?.refs).toStrictEqual(["HEAD"])
    expect(parseLog("")).toStrictEqual([])
  })
})

describe("a git that never exits", () => {
  const neverExits = layer.pipe(
    Layer.provide(
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            }),
          ),
        ),
      ),
    ),
  )

  it.effect("fails a local command after five minutes", () =>
    Effect.gen(function* () {
      const git = yield* Git
      const status = yield* Effect.forkChild(Effect.flip(git.run("/repo", ["status"])))
      yield* TestClock.adjust("299 seconds")
      expect(status.pollUnsafe()).toBeUndefined()

      yield* TestClock.adjust("1 second")
      expect(yield* Fiber.join(status)).toMatchObject({ _tag: "CommandError", exitCode: 124 })
    }).pipe(Effect.provide(neverExits)),
  )

  it.effect("gives a fetch an hour", () =>
    Effect.gen(function* () {
      const git = yield* Git
      const fetch = yield* Effect.forkChild(Effect.flip(git.remote("/repo", ["fetch", "origin"])))
      yield* TestClock.adjust("59 minutes")
      expect(fetch.pollUnsafe()).toBeUndefined()

      yield* TestClock.adjust("1 minute")
      expect(yield* Fiber.join(fetch)).toMatchObject({ _tag: "CommandError", exitCode: 124 })
    }).pipe(Effect.provide(neverExits)),
  )
})
