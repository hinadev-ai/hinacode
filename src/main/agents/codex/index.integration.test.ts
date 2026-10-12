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

type Control = {
  accountResponse?: unknown
  rateLimitsResponse?: unknown
  stall?: Array<string>
  release?: boolean
  holdTurn?: boolean
  question?: Array<import("./protocol.ts").ToolRequestUserInputQuestion>
  postedQuestions?: Array<import("./protocol.ts").AsyncUserInputQuestion>
  cancelQuestion?: boolean
}
type Received = {
  method?: string
  params?: { turnId?: string }
  id?: number
  result?: import("./protocol.ts").ToolRequestUserInputResponse
}

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

describe("Codex token usage", () => {
  it.live("sums the turn's requests and reports the last one against the context window", () =>
    withProvider(
      Effect.gen(function* () {
        const turn = yield* startTurn("thread-a")
        yield* finishesSoon(turn.fiber)
        expect(turn.events.at(-1)).toStrictEqual({
          type: "turn_completed",
          usage: { inputTokens: 3200, outputTokens: 80, context: { usedTokens: 2230, maxTokens: 258400 } },
        })
      }),
    ),
  )
})

const question = {
  id: "color",
  header: "Color",
  question: "Which color?",
  isOther: true,
  isSecret: false,
  options: [{ label: "blue", description: "Cool" }],
} satisfies import("./protocol.ts").ToolRequestUserInputQuestion

const pendingQuestion = (turn: Turn) => {
  const requested = turn.events.find((event) => event.type === "question_requested")
  if (requested?.type !== "question_requested") throw new Error("No pending question")
  return requested.request
}

describe("Codex questions", () => {
  it.live("maps blocking questions and returns option and typed answers on the request id", () =>
    withProvider(
      Effect.gen(function* () {
        const provider = yield* CodexProvider
        setControl({ question: [question] })
        const turn = yield* startTurn("question-thread")
        yield* untilEvent(turn, (event) => event.type === "question_requested")
        const request = pendingQuestion(turn)
        expect(request.questions).toMatchObject([{ id: "color", allowsText: true, multiSelect: false, secret: false }])
        yield* provider.respondQuestion(request.id, { color: ["green"] })
        yield* finishesSoon(turn.fiber)
        expect(received().find((message) => message.id === 901)).toStrictEqual({
          id: 901,
          result: { answers: { color: { answers: ["green"] } } },
        })
        expect(turn.events.some((event) => event.type === "question_resolved" && event.requestId === request.id)).toBe(
          true,
        )
      }),
    ),
  )

  it.live("Stop cancels a pending question with empty answers and leaves the next turn usable", () =>
    withProvider(
      Effect.gen(function* () {
        const provider = yield* CodexProvider
        setControl({ question: [question] })
        const turn = yield* startTurn("question-thread")
        yield* untilEvent(turn, (event) => event.type === "question_requested")
        const request = pendingQuestion(turn)
        yield* provider.interrupt("question-thread")
        yield* finishesSoon(turn.fiber)
        yield* waitFor(() => received().some((message) => message.id === 901))
        expect(received().find((message) => message.id === 901)).toStrictEqual({ id: 901, result: { answers: {} } })
        yield* provider.respondQuestion(request.id, { color: ["late"] })
        setControl({})
        const next = yield* startTurn("question-thread")
        yield* finishesSoon(next.fiber)
        expect(next.events.at(-1)?.type).toBe("turn_completed")
      }),
    ),
  )

  it.live("server cancellation removes the pending card without sending a stale answer", () =>
    withProvider(
      Effect.gen(function* () {
        const provider = yield* CodexProvider
        setControl({ question: [question] })
        const turn = yield* startTurn("question-thread")
        yield* untilEvent(turn, (event) => event.type === "question_requested")
        const request = pendingQuestion(turn)
        setControl({ cancelQuestion: true })
        yield* finishesSoon(turn.fiber)
        yield* provider.respondQuestion(request.id, { color: ["late"] })
        expect(turn.events.some((event) => event.type === "question_resolved" && event.requestId === request.id)).toBe(
          true,
        )
        expect(received().filter((message) => message.id === 901)).toStrictEqual([])
      }),
    ),
  )

  it.live("keeps asynchronous questions in the transcript after turn completion", () =>
    withProvider(
      Effect.gen(function* () {
        setControl({ postedQuestions: [{ title: "Which color?", options: ["blue", "green"] }] })
        const turn = yield* startTurn("posted-thread")
        yield* finishesSoon(turn.fiber)
        expect(turn.events.find((event) => event.type === "questions_posted")).toMatchObject({
          type: "questions_posted",
          text: "Posted question",
          questions: [{ id: "Which color?", allowsText: true }],
        })
      }),
    ),
  )
})

describe("Codex account boundary", () => {
  for (const response of [
    {},
    { account: { type: "futureAccount", apiKey: "synthetic-secret" }, requiresOpenaiAuth: true },
    { account: { type: "chatgpt", email: "dev@example.com" }, requiresOpenaiAuth: true },
    { account: { type: "chatgpt", email: 123, planType: "pro" }, requiresOpenaiAuth: true },
  ]) {
    it.live(`rejects malformed account responses: ${JSON.stringify(response)}`, () =>
      withProvider(
        Effect.gen(function* () {
          setControl({ accountResponse: response })
          const provider = yield* CodexProvider
          const error = yield* provider.account.pipe(Effect.flip)
          expect(error._tag).toBe("AgentError")
          expect(error.message).toMatch(/invalid.*account|account.*invalid/i)
          expect(error.message).not.toContain("synthetic-secret")
        }),
      ),
    )
  }

  it.live("normalizes account metadata and drops credentials", () =>
    withProvider(
      Effect.gen(function* () {
        setControl({
          accountResponse: {
            account: { type: "chatgpt", email: "dev@example.com", planType: "pro", accessToken: "synthetic-secret" },
            requiresOpenaiAuth: true,
            refreshToken: "synthetic-secret",
          },
        })
        const provider = yield* CodexProvider
        expect(yield* provider.account).toStrictEqual({
          type: "subscription",
          email: "dev@example.com",
          plan: "ChatGPT Pro",
          organization: null,
        })
        expect(countOf("turn/start")).toBe(0)
      }),
    ),
  )
})

// Trimmed from codex-cli 0.162 on a ChatGPT plan.
const snapshot = (limitId: string, primary: unknown, secondary: unknown) => ({
  limitId,
  limitName: null,
  normalModelSlug: null,
  primary,
  secondary,
  credits: { hasCredits: false, unlimited: false, balance: "0" },
  individualLimit: null,
  spendControlReached: false,
  planType: "prolite",
  rateLimitReachedType: null,
})

describe("Codex plan limits", () => {
  it.live("reads the codex bucket and names windows by their length", () =>
    withProvider(
      Effect.gen(function* () {
        const weekly = { usedPercent: 69, windowDurationMins: 10080, resetsAt: 1792335112 }
        setControl({
          rateLimitsResponse: {
            ordinaryUsageAllowed: true,
            rateLimits: snapshot("codex", weekly, null),
            rateLimitsByLimitId: {
              codex: snapshot(
                "codex",
                { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1792000000 },
                { usedPercent: 40, windowDurationMins: 60, resetsAt: null },
              ),
              codex_other: snapshot("codex_other", weekly, null),
            },
            rateLimitResetCredits: null,
            accountId: "account-1",
            rateLimitUpsell: null,
          },
        })
        const provider = yield* CodexProvider
        expect(yield* provider.planLimits).toStrictEqual({
          windows: [
            { window: { kind: "session" }, usedPercent: 12.5, resetsAt: "2026-10-14T17:46:40.000Z" },
            { window: { kind: "minutes", minutes: 60 }, usedPercent: 40, resetsAt: null },
          ],
          readAt: expect.any(String),
        })

        setControl({
          rateLimitsResponse: { rateLimits: snapshot("codex", weekly, null), rateLimitsByLimitId: null },
        })
        expect((yield* provider.planLimits)?.windows).toStrictEqual([
          { window: { kind: "weekly" }, usedPercent: 69, resetsAt: "2026-10-18T14:51:52.000Z" },
        ])
      }),
    ),
  )

  it.live("fails on a malformed answer", () =>
    withProvider(
      Effect.gen(function* () {
        setControl({ rateLimitsResponse: { rateLimits: { primary: { usedPercent: "lots" } } } })
        const provider = yield* CodexProvider
        expect((yield* provider.planLimits.pipe(Effect.flip)).message).toMatch(/plan limits/)
      }),
    ),
  )
})
