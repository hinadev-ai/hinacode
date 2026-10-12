import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { AgentEvent, RunTurnInput } from "../../../shared/agent.ts"
import { CodexProvider } from "./index.ts"

const bin = mkdtempSync(join(tmpdir(), "kk-fake-codex-"))
writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec node ${join(import.meta.dirname, "fakeAppServer.mjs")} "$@"\n`)
chmodSync(join(bin, "codex"), 0o755)
process.env.PATH = `${bin}:${process.env.PATH}`

type Control = { stall?: Array<string>; release?: boolean; holdTurn?: boolean }
type Received = { method: string; params?: { turnId?: string } }

let logPath = ""
let controlPath = ""

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "kk-fake-codex-run-"))
  logPath = join(dir, "log.jsonl")
  controlPath = join(dir, "control.json")
  writeFileSync(logPath, "")
  setControl({})
  process.env.FAKE_CODEX_LOG = logPath
  process.env.FAKE_CODEX_CONTROL = controlPath
})

const setControl = (control: Control) => writeFileSync(controlPath, JSON.stringify(control))

const received = (): Array<Received> =>
  readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))

/** Waits in real time, so it also works under TestClock. */
const waitFor = (description: string, predicate: () => boolean) =>
  Effect.promise(async () => {
    for (let attempt = 0; attempt < 250; attempt++) {
      if (predicate()) return
      await sleep(20)
    }
    throw new Error(`timed out waiting for ${description}`)
  })

const countOf = (method: string) => received().filter((message) => message.method === method).length

const input = (threadId: string): RunTurnInput => ({
  threadId,
  prompt: "hello",
  attachments: [],
  cwd: tmpdir(),
  model: "fake-model",
  effort: null,
  fastMode: false,
  accessMode: "auto",
  resumeSessionId: null,
  mcpServer: { url: "http://127.0.0.1:1/mcp", headers: { authorization: "Bearer test" } },
})

const startTurn = (threadId: string) =>
  Effect.gen(function* () {
    const provider = yield* CodexProvider
    const events: Array<AgentEvent> = []
    const fiber = yield* provider.runTurn(input(threadId)).pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.forkChild,
    )
    return { fiber, events }
  })

/** Real-time bound, so it also works under TestClock. */
const finishesSoon = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.raceFirst(
    Fiber.join(fiber),
    Effect.promise((signal) => sleep(3000, undefined, { signal })).pipe(
      Effect.andThen(Effect.die("run fiber is still running")),
    ),
  )

/** A fresh app-server per test, torn down with the test scope. */
const withProvider = <A, E>(effect: Effect.Effect<A, E, CodexProvider>) =>
  effect.pipe(Effect.provide(CodexProvider.layer))

describe("Codex Stop during startup", () => {
  for (const phase of ["initialize", "thread/start", "turn/start"]) {
    it.live(`ends the run while ${phase} is pending and leaves the thread usable`, () =>
      withProvider(
        Effect.gen(function* () {
          const provider = yield* CodexProvider
          setControl({ stall: [phase] })
          const stopped = yield* startTurn("thread-a")
          yield* waitFor(phase, () => countOf(phase) === 1)

          yield* provider.interrupt("thread-a")
          yield* finishesSoon(stopped.fiber)
          expect(stopped.events.at(-1)).toStrictEqual({ type: "turn_failed", message: "Turn interrupted" })

          setControl({})
          const next = yield* startTurn("thread-a")
          yield* finishesSoon(next.fiber)
          expect(next.events.at(-1)?.type).toBe("turn_completed")
        }),
      ),
    )
  }

  it.live("interrupts a turn whose turn/start reply arrives after Stop", () =>
    withProvider(
      Effect.gen(function* () {
        const provider = yield* CodexProvider
        setControl({ stall: ["turn/start"], holdTurn: true })
        const stopped = yield* startTurn("thread-a")
        yield* waitFor("turn/start", () => countOf("turn/start") === 1)
        yield* provider.interrupt("thread-a")
        yield* finishesSoon(stopped.fiber)

        setControl({ stall: ["turn/start"], holdTurn: true, release: true })
        yield* waitFor("turn/interrupt for the late turn", () =>
          received().some((message) => message.method === "turn/interrupt" && message.params?.turnId === "turn-1"),
        )
      }),
    ),
  )

  // `it.effect` runs under TestClock, so the provider's startup timeout only fires when the test advances it.
  it.effect("fails with an actionable error when initialize never answers", () =>
    withProvider(
      Effect.gen(function* () {
        setControl({ stall: ["initialize"] })
        const { fiber, events } = yield* startTurn("thread-a")
        yield* waitFor("initialize", () => countOf("initialize") === 1)
        yield* TestClock.adjust("5 minutes")
        const error = yield* finishesSoon(fiber).pipe(Effect.flip)
        expect(error.message).toMatch(/initialize.*did not respond/)
        expect(events.length).toBe(0)
      }),
    ),
  )
})

describe("Codex Stop on a running turn", () => {
  it.live("sends turn/interrupt and leaves other threads running", () =>
    withProvider(
      Effect.gen(function* () {
        const provider = yield* CodexProvider
        setControl({ holdTurn: true })
        const running = yield* startTurn("thread-b")
        yield* waitFor("first delta", () => running.events.some((event) => event.type === "text_delta"))

        setControl({ holdTurn: true, stall: ["thread/start"] })
        const stopped = yield* startTurn("thread-a")
        yield* waitFor("second thread/start", () => countOf("thread/start") === 2)
        yield* provider.interrupt("thread-a")
        yield* finishesSoon(stopped.fiber)
        expect(running.fiber.pollUnsafe()).toBe(undefined)

        yield* provider.interrupt("thread-b")
        yield* finishesSoon(running.fiber)
        expect(countOf("turn/interrupt")).toBe(1)
        expect(running.events.at(-1)).toStrictEqual({ type: "turn_failed", message: "Turn interrupted" })
      }),
    ),
  )
})
