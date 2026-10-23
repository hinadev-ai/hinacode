import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, watch, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, PubSub, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { AccountHome, AgentEvent, RunTurnInput } from "../../../shared/agent.ts"
import { AGENT_INSTRUCTIONS } from "../instructions.ts"
import type { BackgroundTasksChange } from "../provider.ts"
import { CodexProvider } from "./index.ts"

const bin = mkdtempSync(join(tmpdir(), "kk-fake-codex-"))
writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec node ${join(import.meta.dirname, "fakeAppServer.mjs")} "$@"\n`)
chmodSync(join(bin, "codex"), 0o755)
process.env.PATH = `${bin}:${process.env.PATH}`
// The CLI's own home must not leak in from the machine running the tests.
delete process.env.CODEX_HOME

type Control = {
  accountResponse?: unknown
  rateLimitsResponse?: unknown
  stall?: Array<string>
  release?: boolean
  holdTurn?: boolean
  question?: Array<import("./protocol.ts").ToolRequestUserInputQuestion>
  postedQuestions?: Array<import("./protocol.ts").AsyncUserInputQuestion>
  cancelQuestion?: boolean
  accountFromHome?: boolean
  subagent?: boolean
  subagentPending?: boolean
  plan?: boolean
  compaction?: boolean
  backgroundTerminal?: boolean
  skills?: import("./protocol.ts").SkillsListResponse["data"]
}
type Received = {
  method?: string
  params?: {
    turnId?: string
    input?: Array<import("./protocol.ts").UserInput>
    config?: { model_auto_compact_token_limit?: number }
  }
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
    .slice(0, -1)
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

const input = (threadId: string, home: AccountHome | null = null): RunTurnInput => ({
  threadId,
  prompt: "hello",
  attachments: [],
  cwd: tmpdir(),
  model: "fake-model",
  effort: null,
  fastMode: false,
  autoCompactTokens: null,
  userSkills: true,
  accessMode: "auto",
  resumeSessionId: null,
  home,
  mcpServer: { url: "http://127.0.0.1:1/mcp", headers: { authorization: "Bearer test" } },
  instructions: AGENT_INSTRUCTIONS,
})

const startTurn = (threadId: string, home: AccountHome | null = null) =>
  Effect.gen(function* () {
    const provider = yield* CodexProvider
    const events: Array<AgentEvent> = []
    const arrived = yield* PubSub.unbounded<AgentEvent>()
    const fiber = yield* provider.runTurn(input(threadId, home)).pipe(
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

describe("Codex app-server log", () => {
  it("reads an appended message only after its JSONL terminator arrives", () => {
    const first = { id: 1, method: "initialize" }
    const next = { id: 2, method: "turn/start" }
    const line = JSON.stringify(next)
    const split = line.indexOf("turn/start") + 4
    expect(received()).toStrictEqual([])

    appendFileSync(logPath, `${JSON.stringify(first)}\n${line.slice(0, split)}`)
    expect(received()).toStrictEqual([first])

    appendFileSync(logPath, line.slice(split))
    expect(received()).toStrictEqual([first])

    appendFileSync(logPath, "\n")
    expect(received()).toStrictEqual([first, next])
    expect(countOf("turn/start")).toBe(1)
  })

  it("rejects malformed newline-terminated messages", () => {
    writeFileSync(logPath, '{"method":"turn/start"\n')
    expect(received).toThrow(SyntaxError)
  })
})

describe("Codex auto-compact", () => {
  it.live("passes the threshold to Codex and shows the compaction it runs", () =>
    withProvider(
      Effect.gen(function* () {
        const provider = yield* CodexProvider
        setControl({ compaction: true })
        const events = yield* provider
          .runTurn({ ...input("auto-compact"), autoCompactTokens: 200_000 })
          .pipe(Stream.runCollect)
        const started = received().find((message) => message.method === "thread/start")
        expect(started?.params?.config?.model_auto_compact_token_limit).toBe(200_000)
        expect(events.filter((event) => event.type === "compaction_updated")).toStrictEqual([
          { type: "compaction_updated", compaction: { status: "running" } },
          {
            type: "compaction_updated",
            compaction: { status: "done", trigger: "auto", preTokens: null, postTokens: null },
          },
        ])
      }),
    ),
  )

  it.live("unloads a loaded thread before resuming it with a new threshold", () =>
    withProvider(
      Effect.gen(function* () {
        const provider = yield* CodexProvider
        setControl({})
        const turn = (autoCompactTokens: number | null) =>
          provider
            .runTurn({ ...input("threshold-change"), resumeSessionId: "codex-thread", autoCompactTokens })
            .pipe(Stream.runDrain)
        yield* turn(500_000)
        yield* turn(500_000)
        expect(countOf("thread/unsubscribe")).toBe(0)
        yield* turn(200_000)
        yield* turn(null)
        const methods = received()
          .map((message) => message.method)
          .filter((method) => method === "thread/unsubscribe" || method === "thread/resume")
        expect(methods).toStrictEqual([
          "thread/resume",
          "thread/resume",
          "thread/unsubscribe",
          "thread/resume",
          "thread/unsubscribe",
          "thread/resume",
        ])
      }),
    ),
  )

  it.live("leaves Codex's own threshold alone by default", () =>
    withProvider(
      Effect.gen(function* () {
        const provider = yield* CodexProvider
        setControl({})
        yield* provider.runTurn(input("default-compact")).pipe(Stream.runDrain)
        const started = received().find((message) => message.method === "thread/start")
        expect(started?.params?.config).not.toHaveProperty("model_auto_compact_token_limit")
      }),
    ),
  )
})

describe("Codex conversation mode", () => {
  it.live("does not explicitly load user skills named in a conversation prompt", () =>
    withProvider(
      Effect.gen(function* () {
        const provider = yield* CodexProvider
        setControl({
          skills: [
            {
              cwd: tmpdir(),
              skills: [
                {
                  name: "personal",
                  description: "User skill",
                  path: "/user/personal/SKILL.md",
                  scope: "user",
                  enabled: true,
                },
                {
                  name: "project",
                  description: "Project skill",
                  path: "/repo/project/SKILL.md",
                  scope: "repo",
                  enabled: true,
                },
              ],
            },
          ],
        })
        yield* provider
          .runTurn({ ...input("conversation"), userSkills: false, prompt: "$personal $project" })
          .pipe(Stream.runDrain)
        const started = received().find((message) => message.method === "turn/start")
        expect(started?.params?.input?.filter((item) => item.type === "skill")).toStrictEqual([
          { type: "skill", name: "project", path: "/repo/project/SKILL.md" },
        ])
      }),
    ),
  )
})

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

describe("Codex plan", () => {
  it.live("stores a plan update as an update_plan tool call", () =>
    withProvider(
      Effect.gen(function* () {
        setControl({ plan: true })
        const turn = yield* startTurn("plan-thread")
        yield* finishesSoon(turn.fiber)
        expect(turn.events.filter((event) => event.type.startsWith("tool_call"))).toStrictEqual([
          {
            type: "tool_call_started",
            callId: "plan-turn-1-1",
            name: "update_plan",
            input: {
              explanation: "Two steps",
              plan: [
                { step: "Read the code", status: "completed" },
                { step: "Write the fix", status: "inProgress" },
              ],
            },
          },
          { type: "tool_call_finished", callId: "plan-turn-1-1", output: "Plan updated", isError: false },
        ])
      }),
    ),
  )
})

describe("Codex sub-agents", () => {
  it.live("stops a sub-agent before its first item starts", () =>
    withProvider(
      Effect.gen(function* () {
        const provider = yield* CodexProvider
        setControl({ subagent: true, subagentPending: true, holdTurn: true })
        const turn = yield* startTurn("subagent-thread")
        yield* untilEvent(turn, (event) => event.type === "text_delta")

        yield* (provider.stopSubagent ?? (() => Effect.die("stopSubagent is missing")))(
          "subagent-thread",
          "codex-child-thread",
        )
        expect(received().filter((message) => message.method === "turn/interrupt")).toMatchObject([
          { params: { threadId: "codex-child-thread", turnId: "child-turn" } },
        ])

        yield* provider.interrupt("subagent-thread")
        yield* finishesSoon(turn.fiber)
      }),
    ),
  )

  it.live("reports when a sub-agent cannot be stopped after its parent turn ends", () =>
    withProvider(
      Effect.gen(function* () {
        const provider = yield* CodexProvider
        setControl({ subagent: true })
        const turn = yield* startTurn("subagent-thread")
        yield* finishesSoon(turn.fiber)

        const result = yield* Effect.exit(
          (provider.stopSubagent ?? (() => Effect.die("stopSubagent is missing")))(
            "subagent-thread",
            "codex-child-thread",
          ),
        )
        expect(result._tag).toBe("Failure")
      }),
    ),
  )

  it.live("puts the sub-agent's tool calls in the transcript tagged with its thread id", () =>
    withProvider(
      Effect.gen(function* () {
        setControl({ subagent: true })
        const turn = yield* startTurn("subagent-thread")
        yield* finishesSoon(turn.fiber)
        const subagent = turn.events.find((event) => event.type === "subagent_updated")
        expect(subagent).toMatchObject({ subagent: { id: "codex-child-thread", callId: "codex-child-thread" } })
        expect(turn.events.filter((event) => event.type.startsWith("tool_call"))).toStrictEqual([
          {
            type: "tool_call_started",
            callId: "child-exec",
            name: "Bash",
            input: expect.objectContaining({ command: "wc -l" }),
            parentCallId: "codex-child-thread",
          },
          { type: "tool_call_finished", callId: "child-exec", output: "218\n", isError: false },
        ])
      }),
    ),
  )

  it.live("stops one sub-agent by interrupting its own turn, and keeps the parent's", () =>
    withProvider(
      Effect.gen(function* () {
        const provider = yield* CodexProvider
        setControl({ subagent: true, holdTurn: true })
        const turn = yield* startTurn("subagent-thread")
        yield* untilEvent(turn, (event) => event.type === "tool_call_finished")

        yield* (provider.stopSubagent ?? (() => Effect.die("stopSubagent is missing")))(
          "subagent-thread",
          "codex-child-thread",
        )
        const interrupts = received().flatMap((message) =>
          message.method === "turn/interrupt" ? [message.params] : [],
        )
        expect(interrupts).toStrictEqual([{ threadId: "codex-child-thread", turnId: "child-turn" }])
        expect(turn.fiber.pollUnsafe()).toBe(undefined)

        yield* provider.interrupt("subagent-thread")
        yield* finishesSoon(turn.fiber)
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

describe("Codex background terminals", () => {
  it.live("lists a command left running after the turn, stops it, and empties the set", () =>
    withProvider(
      Effect.gen(function* () {
        const provider = yield* CodexProvider
        const backgroundTasks = provider.backgroundTasks ?? (yield* Effect.die("backgroundTasks is missing"))
        const changes = yield* Queue.unbounded<BackgroundTasksChange>()
        yield* backgroundTasks.changes.pipe(
          Stream.runForEach((change) => Queue.offer(changes, change)),
          Effect.forkChild,
        )
        setControl({ backgroundTerminal: true })
        const turn = yield* startTurn("terminal-thread")
        yield* finishesSoon(turn.fiber)
        expect(turn.events).toContainEqual({
          type: "tool_call_finished",
          callId: "dev-server",
          output: "Running in the background",
          isError: false,
        })

        expect(yield* Queue.take(changes)).toMatchObject({
          threadId: "terminal-thread",
          tasks: [{ id: "1001", kind: "shell", label: "pnpm dev", startedAt: expect.any(String) }],
        })

        yield* backgroundTasks.stop("terminal-thread", "1001")
        expect(received().filter((message) => message.method === "thread/backgroundTerminals/terminate")).toMatchObject(
          [{ params: { threadId: "codex-thread", processId: "1001" } }],
        )
        expect(yield* Queue.take(changes)).toStrictEqual({ threadId: "terminal-thread", tasks: [] })
      }),
    ),
  )
})

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
          const error = yield* provider.account(null).pipe(Effect.flip)
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
        expect(yield* provider.account(null)).toStrictEqual({
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
        expect(yield* provider.planLimits(null)).toStrictEqual({
          windows: [
            { window: { kind: "session" }, usedPercent: 12.5, resetsAt: "2026-10-14T17:46:40.000Z" },
            { window: { kind: "minutes", minutes: 60 }, usedPercent: 40, resetsAt: null },
          ],
          readAt: expect.any(String),
        })

        setControl({
          rateLimitsResponse: { rateLimits: snapshot("codex", weekly, null), rateLimitsByLimitId: null },
        })
        expect((yield* provider.planLimits(null))?.windows).toStrictEqual([
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
        expect((yield* provider.planLimits(null).pipe(Effect.flip)).message).toMatch(/plan limits/)
      }),
    ),
  )
})

const homes = () => {
  const root = mkdtempSync(join(tmpdir(), "kk-codex-homes-"))
  const home = (name: string): AccountHome => ({ dir: join(root, name), binary: "codex" })
  return { work: home("work"), personal: home("personal") }
}

describe("Codex accounts", () => {
  it.live("runs one app-server per home, each with its own CODEX_HOME", () =>
    withProvider(
      Effect.gen(function* () {
        const { work, personal } = homes()
        setControl({ accountFromHome: true })
        const provider = yield* CodexProvider
        expect(yield* provider.account(work)).toMatchObject({ email: "work@example.com" })
        expect(yield* provider.account(personal)).toMatchObject({ email: "personal@example.com" })
        expect(yield* provider.account(null)).toStrictEqual({ type: "signedOut" })
        expect(yield* provider.account(work)).toMatchObject({ email: "work@example.com" })
        expect(countOf("initialize")).toBe(3)
      }),
    ),
  )

  it.live("reads a thread's tokens from the rollouts in its account's home", () =>
    withProvider(
      Effect.gen(function* () {
        const { work, personal } = homes()
        const threadId = "01a0c6f7-8e77-75b1-9d6a-f583fa33e0da"
        const day = join(work.dir, "sessions", "2026", "10", "12")
        mkdirSync(day, { recursive: true })
        const lines = [
          { type: "session_meta", payload: { session_id: threadId, id: threadId } },
          { type: "turn_context", payload: { model: "gpt-6-astra" } },
          {
            type: "event_msg",
            payload: {
              type: "token_count",
              info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } },
            },
          },
        ]
        writeFileSync(
          join(day, `rollout-2026-10-12T09-00-00-${threadId}.jsonl`),
          lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
        )
        const provider = yield* CodexProvider
        expect((yield* provider.usage(threadId, work))?.models).toStrictEqual([
          { model: "gpt-6-astra", inputTokens: 60, cacheWriteTokens: 0, cacheReadTokens: 40, outputTokens: 7 },
        ])
        expect(yield* provider.usage(threadId, personal)).toBeNull()
      }),
    ),
  )

  it.live("interrupts a thread's turn on its own account's app-server", () =>
    withProvider(
      Effect.gen(function* () {
        const { work, personal } = homes()
        setControl({ holdTurn: true })
        const provider = yield* CodexProvider
        const onWork = yield* startTurn("thread-work", work)
        const onPersonal = yield* startTurn("thread-personal", personal)
        yield* waitFor(() => countOf("turn/start") === 2)

        yield* provider.interrupt("thread-work")
        yield* finishesSoon(onWork.fiber)
        expect(onWork.events.at(-1)).toStrictEqual({ type: "turn_failed", message: "Turn interrupted" })
        expect(onPersonal.events.some((event) => event.type === "turn_failed")).toBe(false)

        yield* provider.interrupt("thread-personal")
        yield* finishesSoon(onPersonal.fiber)
        expect(countOf("turn/interrupt")).toBe(2)
      }),
    ),
  )
})
