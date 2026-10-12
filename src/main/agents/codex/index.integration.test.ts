import { chmodSync, mkdtempSync, readFileSync, watch, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, PubSub, Stream } from "effect"
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

/**
 * Resolves once the fake app-server's log satisfies `predicate`. The log file changing is the signal,
 * so no clock is involved and the wait works under TestClock too.
 */
const waitFor = (predicate: () => boolean) =>
  Effect.callback<void>((resume) => {
    let done = false
    const check = () => {
      if (done || !predicate()) return
      done = true
      watcher.close()
      resume(Effect.void)
    }
    const watcher = watch(logPath, check)
    check()
    return Effect.sync(() => watcher.close())
  })

const countOf = (method: string) => received().filter((message) => message.method === method).length

const input = (threadId: string): RunTurnInput => ({
  threadId,
  prompt: "hello",
  attachments: [],
  cwd: tmpdir(),
  model: "fake-model",
  resumeSessionId: null,
  mcpServer: { url: "http://127.0.0.1:1/mcp", headers: { authorization: "Bearer test" } },
})

const startTurn = (threadId: string) =>
  Effect.gen(function* () {
    const provider = yield* CodexProvider
    const events: Array<AgentEvent> = []
    const arrived = yield* PubSub.unbounded<AgentEvent>()
    const fiber = yield* provider.runTurn(input(threadId)).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => events.push(event)).pipe(Effect.andThen(PubSub.publish(arrived, event))),
      ),
      Effect.forkChild,
    )
    return { fiber, events, arrived }
  })

type Turn = Effect.Success<ReturnType<typeof startTurn>>

/** Resolves once the turn has received an event matching `predicate`; subscribing first means none is missed. */
const untilEvent = (turn: Turn, predicate: (event: AgentEvent) => boolean) =>
  Effect.gen(function* () {
    const updates = yield* PubSub.subscribe(turn.arrived)
    if (turn.events.some(predicate)) return
    while (!predicate(yield* PubSub.take(updates))) continue
  }).pipe(Effect.scoped)

/** A run that never ends fails the test by its timeout; nothing here consults a clock. */
const finishesSoon = <A, E>(fiber: Fiber.Fiber<A, E>) => Fiber.join(fiber)

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
          yield* waitFor(() => countOf(phase) === 1)

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
        yield* waitFor(() => countOf("turn/start") === 1)
        yield* provider.interrupt("thread-a")
        yield* finishesSoon(stopped.fiber)

        setControl({ stall: ["turn/start"], holdTurn: true, release: true })
        yield* waitFor(() =>
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
        yield* waitFor(() => countOf("initialize") === 1)
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
        yield* untilEvent(running, (event) => event.type === "text_delta")

        setControl({ holdTurn: true, stall: ["thread/start"] })
        const stopped = yield* startTurn("thread-a")
        yield* waitFor(() => countOf("thread/start") === 2)
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
