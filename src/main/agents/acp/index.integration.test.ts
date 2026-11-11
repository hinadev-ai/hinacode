import { mkdtempSync, readFileSync, watch, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, PubSub, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { AgentEvent, RunTurnInput } from "../../../shared/agent.ts"
import type { AccessMode } from "../../../shared/domain.ts"
import { agentPidsOf } from "../../services/Ports.ts"
import { makeAcpProvider } from "./index.ts"

const FAKE_AGENT = join(import.meta.dirname, "fakeAgent.ts")

type Logged = {
  id?: number | string
  method?: string
  answered?: string
  error?: { code: number }
  params?: { sessionId?: string; prompt?: Array<{ type: string; text?: string }>; [key: string]: unknown }
  result?: unknown
}

const setup = (env: Record<string, string> = {}) => {
  const logPath = join(mkdtempSync(join(tmpdir(), "kk-fake-acp-")), "log.jsonl")
  writeFileSync(logPath, "")
  const provider = makeAcpProvider({
    id: "opencode",
    binary: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_ACP_LOG: logPath, ...env },
    loginCommand: "fake login",
    account: Effect.succeed({ type: "external", service: "fake" }),
  })
  const received = (): Array<Logged> =>
    readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  return { provider, received, logPath }
}

const agentProcesses = Effect.acquireRelease(
  Effect.callback<{ readonly path: string; readonly allExited: Effect.Effect<void>; readonly close: () => void }>(
    (resume) => {
      const path = join(mkdtempSync(join(tmpdir(), "kk-acp-lifeline-")), "agent.sock")
      let started = 0
      let open = 0
      const waiters = new Set<() => void>()
      const server = createServer((socket) => {
        started++
        open++
        socket.resume()
        socket.on("close", () => {
          open--
          for (const waiter of waiters) waiter()
        })
      })
      const allExited = Effect.callback<void>((done) => {
        const check = () => {
          if (started === 0 || open > 0) return
          waiters.delete(check)
          done(Effect.void)
        }
        waiters.add(check)
        check()
        return Effect.sync(() => waiters.delete(check))
      })
      server.listen(path, () => resume(Effect.succeed({ path, allExited, close: () => server.close() })))
    },
  ),
  ({ close }) => Effect.sync(close),
)

const logged = (logPath: string, method: string, times = 1) =>
  Effect.callback<void>((resume) => {
    const check = () => {
      if (readFileSync(logPath, "utf8").split(`"method":"${method}"`).length - 1 < times) return
      watcher.close()
      resume(Effect.void)
    }
    const watcher = watch(logPath, check)
    check()
    return Effect.sync(() => watcher.close())
  })

const ids = (models: ReadonlyArray<{ readonly id: string }>) => models.map((model) => model.id)

const input = (fields: Partial<RunTurnInput> = {}): RunTurnInput => ({
  threadId: "t1",
  prompt: "hello",
  attachments: [],
  cwd: tmpdir(),
  tmpDirectory: tmpdir(),
  model: "fake/default",
  effort: null,
  fastMode: false,
  autoCompactTokens: null,
  accessMode: "supervised",
  resumeSessionId: null,
  forkAt: null,
  home: null,
  mcpServer: { url: "http://127.0.0.1:9/mcp", headers: { authorization: "Bearer test" } },
  instructions: "You run inside HinaCode.",
  ...fields,
})

type Provider = Effect.Success<ReturnType<typeof setup>["provider"]>

const startTurn = (provider: Provider, turn: RunTurnInput) =>
  Effect.gen(function* () {
    const events: Array<AgentEvent> = []
    const arrived = yield* PubSub.unbounded<AgentEvent>()
    const fiber = yield* provider.runTurn(turn).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => events.push(event)).pipe(Effect.andThen(PubSub.publish(arrived, event))),
      ),
      Effect.forkChild,
    )
    const until = (predicate: (event: AgentEvent) => boolean) =>
      Effect.gen(function* () {
        const updates = yield* PubSub.subscribe(arrived)
        const seen = events.find(predicate)
        if (seen !== undefined) return seen
        while (true) {
          const event = yield* PubSub.take(updates)
          if (predicate(event)) return event
        }
      }).pipe(Effect.scoped)
    return { fiber, events, until }
  })

const runToEnd = (provider: Provider, turn: RunTurnInput) =>
  provider.runTurn(turn).pipe(
    Stream.runCollect,
    Effect.map((chunk) => [...chunk]),
  )

const types = (events: ReadonlyArray<AgentEvent>) => events.map((event) => event.type)

describe("makeAcpProvider", () => {
  it.live("streams a turn and puts the instructions only on a new session's first prompt", () =>
    Effect.gen(function* () {
      const { provider: make, received } = setup()
      const provider = yield* make
      const events = yield* runToEnd(provider, input())
      expect(events).toStrictEqual([
        { type: "session_bound", providerSessionId: "ses_1" },
        { type: "reasoning_delta", text: "Thinking" },
        {
          type: "tool_call_started",
          callId: expect.stringMatching(/-plan-1$/),
          name: "update_plan",
          input: { plan: [{ step: "Reply", status: "in_progress" }] },
        },
        {
          type: "tool_call_finished",
          callId: expect.stringMatching(/-plan-1$/),
          output: "Plan updated",
          isError: false,
        },
        { type: "text_delta", text: "echo: hello" },
        {
          type: "turn_completed",
          usage: { inputTokens: 10, outputTokens: 3, context: { usedTokens: 1200, maxTokens: 200000 } },
        },
      ])

      yield* runToEnd(provider, input({ prompt: "again", resumeSessionId: "ses_1" }))
      const prompts = received().filter((message) => message.method === "session/prompt")
      expect(prompts.map((message) => message.params?.prompt)).toStrictEqual([
        [
          { type: "text", text: "You run inside HinaCode.", annotations: { audience: ["assistant"] } },
          { type: "text", text: "hello" },
        ],
        [{ type: "text", text: "again" }],
      ])
      const opened = received().find((message) => message.method === "session/new")
      expect(opened?.params).toStrictEqual({
        cwd: tmpdir(),
        mcpServers: [
          {
            type: "http",
            name: "hinacode",
            url: "http://127.0.0.1:9/mcp",
            headers: [{ name: "authorization", value: "Bearer test" }],
          },
        ],
      })
      expect(received().filter((message) => message.method?.startsWith("session/set_"))).toStrictEqual([])
      expect(yield* provider.listCommands({ threadId: "t1", cwd: tmpdir(), home: null })).toStrictEqual([
        { trigger: "/", name: "review", description: "Review the diff", argumentHint: "branch" },
      ])
    }).pipe(Effect.scoped),
  )

  it.live("asks before a supervised edit, then finishes the tool call it approved", () =>
    Effect.gen(function* () {
      const { provider: make, received } = setup()
      const provider = yield* make
      const turn = yield* startTurn(provider, input({ prompt: "ask" }))
      const requested = yield* turn.until((event) => event.type === "approval_requested")
      if (requested.type !== "approval_requested") throw new Error("expected an approval")
      expect(requested.request).toStrictEqual({
        id: expect.any(String),
        threadId: "t1",
        provider: "opencode",
        kind: "patch",
        title: "Edit file",
        detail: "--- /fake/hello.txt\n+++ /fake/hello.txt\n+hi\n",
        input: { filePath: "/fake/hello.txt", content: "hi" },
      })
      yield* provider.respondApproval(requested.request.id, "allow")
      yield* Fiber.join(turn.fiber)

      expect(types(turn.events)).toStrictEqual([
        "session_bound",
        "tool_call_started",
        "approval_requested",
        "approval_resolved",
        "tool_call_finished",
        "file_changed",
        "text_delta",
        "turn_completed",
      ])
      expect(turn.events).toContainEqual({ type: "file_changed", path: "/fake/hello.txt" })
      const answers = received().filter((message) => message.id === 1 && message.method === undefined)
      expect(answers.map((message) => message.result)).toStrictEqual([
        { outcome: { outcome: "selected", optionId: "once" } },
      ])
      expect(received().find((message) => message.answered === "fs/write_text_file")?.error?.code).toBe(-32601)
    }).pipe(Effect.scoped),
  )

  for (const accessMode of ["full", "auto"] satisfies Array<AccessMode>) {
    it.live(`answers an edit itself in ${accessMode} mode`, () =>
      Effect.gen(function* () {
        const { provider: make, received } = setup()
        const provider = yield* make
        const events = yield* runToEnd(provider, input({ prompt: "ask", accessMode }))
        expect(types(events)).not.toContain("approval_requested")
        expect(events).toContainEqual({
          type: "tool_call_finished",
          callId: "call_write",
          output: "Wrote file successfully.",
          isError: false,
        })
        const answer = received().find((message) => message.id === 1 && message.method === undefined)
        expect(answer?.result).toStrictEqual({ outcome: { outcome: "selected", optionId: "once" } })
      }).pipe(Effect.scoped),
    )
  }

  it.live("answers a command itself in full mode", () =>
    Effect.gen(function* () {
      const { provider: make, received } = setup()
      const provider = yield* make
      const events = yield* runToEnd(provider, input({ prompt: "ask to run", accessMode: "full" }))
      expect(types(events)).not.toContain("approval_requested")
      expect(events).toContainEqual({
        type: "tool_call_finished",
        callId: "call_run",
        output: "Removed build.",
        isError: false,
      })
      const answer = received().find((message) => message.id === 0 && message.method === undefined)
      expect(answer?.result).toStrictEqual({ outcome: { outcome: "selected", optionId: "once" } })
    }).pipe(Effect.scoped),
  )

  it.live("asks before a command in auto mode", () =>
    Effect.gen(function* () {
      const { provider: make } = setup()
      const provider = yield* make
      const turn = yield* startTurn(provider, input({ prompt: "ask to run", accessMode: "auto" }))
      const requested = yield* turn.until((event) => event.type === "approval_requested")
      if (requested.type !== "approval_requested") throw new Error("expected an approval")
      expect(requested.request).toMatchObject({ kind: "command", title: "Run command", detail: "rm -rf build" })
      yield* provider.respondApproval(requested.request.id, "deny")
      yield* Fiber.join(turn.fiber)
      expect(turn.events).toContainEqual({
        type: "tool_call_finished",
        callId: "call_run",
        output: "Rejected",
        isError: true,
      })
    }).pipe(Effect.scoped),
  )

  it.live("interrupts a turn, closing its open tool call and its pending approval", () =>
    Effect.gen(function* () {
      const { provider: make, received } = setup()
      const provider = yield* make
      const held = yield* startTurn(provider, input({ prompt: "hold" }))
      yield* held.until((event) => event.type === "tool_call_started")
      yield* provider.interrupt("t1")
      yield* Fiber.join(held.fiber)
      expect(held.events.slice(1)).toStrictEqual([
        { type: "tool_call_started", callId: "call_sleep", name: "Bash", input: { command: "sleep 60" } },
        { type: "tool_call_finished", callId: "call_sleep", output: "Interrupted", isError: true },
        { type: "turn_failed", message: "Turn interrupted" },
      ])

      const asking = yield* startTurn(provider, input({ prompt: "ask", resumeSessionId: "ses_1" }))
      yield* asking.until((event) => event.type === "approval_requested")
      yield* provider.interrupt("t1")
      yield* Fiber.join(asking.fiber)
      expect(asking.events.at(-2)).toStrictEqual({
        type: "tool_call_finished",
        callId: "call_write",
        output: "Interrupted",
        isError: true,
      })
      expect(asking.events.at(-1)).toStrictEqual({ type: "turn_failed", message: "Turn interrupted" })
      expect(received().filter((message) => message.method === "session/cancel")).toHaveLength(2)
      const answer = received().find((message) => message.id === 1 && message.method === undefined)
      expect(answer?.result).toStrictEqual({ outcome: { outcome: "cancelled" } })
    }).pipe(Effect.scoped),
  )

  it.live("resumes with session/load and drops the history it replays", () =>
    Effect.gen(function* () {
      const { provider: make, received } = setup()
      const provider = yield* make
      const events = yield* runToEnd(provider, input({ resumeSessionId: "ses_old", model: "fake/other" }))
      expect(events[0]).toStrictEqual({ type: "session_bound", providerSessionId: "ses_old" })
      expect(events.filter((event) => event.type === "text_delta")).toStrictEqual([
        { type: "text_delta", text: "echo: hello" },
      ])
      expect(received().find((message) => message.method === "session/load")?.params).toMatchObject({
        sessionId: "ses_old",
        cwd: tmpdir(),
      })
      expect(received().find((message) => message.method === "session/set_config_option")?.params).toStrictEqual({
        sessionId: "ses_old",
        configId: "model",
        value: "fake/other",
      })
      const prompt = received().find((message) => message.method === "session/prompt")?.params?.prompt
      expect(prompt).toStrictEqual([{ type: "text", text: "hello" }])
    }).pipe(Effect.scoped),
  )

  it.live("fails the turn rather than start a session without the thread's history", () =>
    Effect.gen(function* () {
      const { provider: make, received } = setup()
      const provider = yield* make
      const error = yield* runToEnd(provider, input({ resumeSessionId: "ses_missing" })).pipe(Effect.flip)
      expect(error.message).toBe("opencode session/load failed: Session not found")
      expect(received().filter((message) => message.method === "session/new")).toStrictEqual([])
    }).pipe(Effect.scoped),
  )

  it.live("lists models from configOptions with the agent's default first", () =>
    Effect.gen(function* () {
      const { provider: make, received } = setup()
      const provider = yield* make
      const models = yield* provider.listModels
      expect(models.map((model) => [model.id, model.label, model.efforts])).toStrictEqual([
        ["fake/default", "Fake Default", []],
        ["fake/other", "Fake Other", ["low", "high"]],
      ])
      yield* provider.listModels
      expect(received().filter((message) => message.method === "session/new")).toHaveLength(1)
    }).pipe(Effect.scoped),
  )

  it.effect("probes models again after an empty list, then once per ten minutes, for all pickers at once", () =>
    Effect.gen(function* () {
      const { provider: make, received } = setup({ FAKE_ACP_MODELS: "after-first-session" })
      const provider = yield* make
      const probes = () => received().filter((message) => message.method === "session/new").length

      expect(yield* provider.listModels).toStrictEqual([])
      const [first, second] = yield* Effect.all([provider.listModels, provider.listModels], { concurrency: 2 })
      expect([ids(first), ids(second)]).toStrictEqual([
        ["fake/default", "fake/other"],
        ["fake/default", "fake/other"],
      ])
      expect(probes()).toBe(2)

      yield* TestClock.adjust("9 minutes")
      yield* provider.listModels
      expect(probes()).toBe(2)
    }).pipe(Effect.scoped),
  )

  it.effect("answers with the last models at once after ten minutes, and probes again in the background", () =>
    Effect.gen(function* () {
      const { provider: make, logPath } = setup({ FAKE_ACP_MODELS: "stall-after-first-session" })
      const provider = yield* make
      const models = yield* provider.listModels

      yield* TestClock.adjust("11 minutes")
      expect(yield* provider.listModels).toStrictEqual(models)
      yield* logged(logPath, "session/new", 2)
    }).pipe(Effect.scoped),
  )

  it.effect("replaces the last models with the list a background probe brings back", () =>
    Effect.gen(function* () {
      const { provider: make, logPath } = setup({ FAKE_ACP_MODELS: "new-after-first-session" })
      const provider = yield* make
      expect(ids(yield* provider.listModels)).toStrictEqual(["fake/default", "fake/other"])

      yield* TestClock.adjust("11 minutes")
      expect(ids(yield* provider.listModels)).toStrictEqual(["fake/default", "fake/other"])
      yield* logged(logPath, "session/new", 2)
      const refreshed = yield* provider.listModels.pipe(
        Effect.tap(() => Effect.yieldNow),
        Effect.repeat({ until: (models) => models.length === 3 }),
      )
      expect(ids(refreshed)).toStrictEqual(["fake/default", "fake/other", "fake/new"])
    }).pipe(Effect.scoped),
  )

  it.effect("drops the last models once a background probe finds the agent signed out", () =>
    Effect.gen(function* () {
      const { provider: make } = setup({ FAKE_ACP_AUTH: "after-first-session" })
      const provider = yield* make
      const models = yield* provider.listModels

      yield* TestClock.adjust("11 minutes")
      expect(yield* provider.listModels).toStrictEqual(models)
      const error = yield* provider.listModels.pipe(
        Effect.tap(() => Effect.yieldNow),
        Effect.forever,
        Effect.flip,
      )
      expect(error.message).toBe("opencode is not signed in")
    }).pipe(Effect.scoped),
  )

  it.live("shares one failed probe among pickers that open at once, and probes again on the next open", () =>
    Effect.gen(function* () {
      const { provider: make, received } = setup({ FAKE_ACP_AUTH: "required" })
      const provider = yield* make
      const probes = () => received().filter((message) => message.method === "session/new").length

      const failures = yield* Effect.all(
        Array.from({ length: 3 }, () => Effect.flip(provider.listModels)),
        {
          concurrency: 3,
        },
      )
      expect(failures.map((error) => error.message)).toStrictEqual(Array(3).fill(failures[0]!.message))
      expect(failures[0]!.message).toBe("opencode is not signed in")
      expect(probes()).toBe(1)

      yield* Effect.flip(provider.listModels)
      expect(probes()).toBe(2)
    }).pipe(Effect.scoped),
  )

  it.live("lists a new thread's commands from a session opened in its cwd, once per cwd", () =>
    Effect.gen(function* () {
      const { provider: make, received } = setup()
      const provider = yield* make
      const cwd = mkdtempSync(join(tmpdir(), "kk-acp-project-"))
      const review = { trigger: "/", name: "review", description: "Review the diff", argumentHint: "branch" }
      expect(yield* provider.listCommands({ threadId: "t1", cwd, home: null })).toStrictEqual([review])
      expect(yield* provider.listCommands({ threadId: "t2", cwd, home: null })).toStrictEqual([review])
      expect(received().filter((message) => message.method === "session/new")).toMatchObject([
        { params: { cwd, mcpServers: [] } },
      ])
    }).pipe(Effect.scoped),
  )

  it.live("sets the effort a turn asks for, and refuses one the model does not offer", () =>
    Effect.gen(function* () {
      const { provider: make, received } = setup()
      const provider = yield* make
      yield* runToEnd(provider, input({ model: "fake/other", effort: "high" }))
      yield* runToEnd(provider, input({ model: "fake/other", effort: null, resumeSessionId: "ses_1" }))
      const efforts = received()
        .filter(
          (message) => message.method === "session/set_config_option" && message.params?.["configId"] === "effort",
        )
        .map((message) => message.params?.["value"])
      expect(efforts).toStrictEqual(["high"])

      const refused = yield* runToEnd(provider, input({ model: "fake/other", effort: "max" })).pipe(Effect.flip)
      expect(refused.message).toBe("fake/other has no max effort. Its levels: low, high.")
      const none = yield* runToEnd(provider, input({ effort: "high" })).pipe(Effect.flip)
      expect(none.message).toBe("fake/default has no high effort. Its levels: none.")
    }).pipe(Effect.scoped),
  )

  it.live("lists models from the older models field and picks one with set_model", () =>
    Effect.gen(function* () {
      const { provider: make, received } = setup({ FAKE_ACP_MODELS: "legacy" })
      const provider = yield* make
      expect((yield* provider.listModels).map((model) => model.id)).toStrictEqual(["legacy-default", "legacy-other"])
      yield* runToEnd(provider, input({ model: "legacy-other" }))
      yield* runToEnd(provider, input({ model: "legacy-other", resumeSessionId: "ses_2" }))
      expect(received().filter((message) => message.method === "session/set_model")).toMatchObject([
        { params: { sessionId: "ses_2", modelId: "legacy-other" } },
        { params: { sessionId: "ses_2", modelId: "legacy-other" } },
      ])
    }).pipe(Effect.scoped),
  )

  it.live("tells the developer how to sign in when the agent requires it", () =>
    Effect.gen(function* () {
      const { provider: make } = setup({ FAKE_ACP_AUTH: "required" })
      const provider = yield* make
      const error = yield* runToEnd(provider, input()).pipe(Effect.flip)
      expect(error).toMatchObject({ message: "opencode is not signed in", loginCommand: "fake login" })
    }).pipe(Effect.scoped),
  )

  it.live("leaves out steering and refuses an added account", () =>
    Effect.gen(function* () {
      const { provider: make } = setup()
      const provider = yield* make
      expect(provider.steer).toBeUndefined()
      const account = yield* provider.account({ dir: "/tmp/x", binary: "opencode" }).pipe(Effect.flip)
      expect(account.message).toBe("opencode runs on its CLI login only")
      expect(yield* provider.account(null)).toStrictEqual({ type: "external", service: "fake" })
    }).pipe(Effect.scoped),
  )

  it.live("runs each turn in its own agent process, so threads never share MCP credentials", () =>
    Effect.gen(function* () {
      const { provider: make, received } = setup()
      const provider = yield* make
      const waiting = yield* startTurn(provider, input({ prompt: "ask" }))
      yield* waiting.until((event) => event.type === "approval_requested")
      const other = { url: "http://127.0.0.1:9/mcp", headers: { authorization: "Bearer other" } }
      yield* runToEnd(provider, input({ threadId: "t2", mcpServer: other }))
      yield* provider.interrupt("t1")
      yield* Fiber.join(waiting.fiber)

      expect(received().filter((message) => message.method === "initialize")).toHaveLength(2)
      const credentials = received()
        .filter((message) => message.method === "session/new")
        .map((message) => message.params?.["mcpServers"])
      expect(credentials).toMatchObject([
        [{ headers: [{ name: "authorization", value: "Bearer test" }] }],
        [{ headers: [{ name: "authorization", value: "Bearer other" }] }],
      ])
    }).pipe(Effect.scoped),
  )
})

describe("an ACP agent that fails", () => {
  it.live("fails the turn when the agent exits mid-turn, with its last words, and closes its open tool call", () =>
    Effect.gen(function* () {
      const agents = yield* agentProcesses
      const { provider: make } = setup({ FAKE_ACP_LIFELINE: agents.path })
      const provider = yield* make
      const turn = yield* startTurn(provider, input({ prompt: "crash" }))
      const error = yield* Fiber.join(turn.fiber).pipe(Effect.flip)
      expect(error.message).toMatch(/exited \(code 3/)
      expect(error.message).toContain("fatal: out of memory")
      expect(turn.events.at(-1)).toStrictEqual({
        type: "tool_call_finished",
        callId: "call_build",
        output: "Turn failed",
        isError: true,
      })
      yield* agents.allExited

      const next = yield* runToEnd(provider, input({ threadId: "t2" }))
      expect(next.at(-1)?.type).toBe("turn_completed")
    }).pipe(Effect.scoped),
  )

  it.live("skips stdout lines that are not JSON-RPC and notifications it cannot read", () =>
    Effect.gen(function* () {
      const { provider: make } = setup()
      const provider = yield* make
      const events = yield* runToEnd(provider, input({ prompt: "noise" }))
      expect(events.filter((event) => event.type === "text_delta")).toStrictEqual([
        { type: "text_delta", text: "echo: noise" },
      ])
      expect(events.at(-1)?.type).toBe("turn_completed")
    }).pipe(Effect.scoped),
  )

  it.live("fails a turn whose prompt answer it cannot read, and stops the agent", () =>
    Effect.gen(function* () {
      const agents = yield* agentProcesses
      const { provider: make } = setup({ FAKE_ACP_LIFELINE: agents.path })
      const provider = yield* make
      const error = yield* runToEnd(provider, input({ prompt: "malformed" })).pipe(Effect.flip)
      expect(error.message).toBe("opencode sent an invalid session/prompt response")
      yield* agents.allExited
    }).pipe(Effect.scoped),
  )

  it.live("stops the agent process when the user stops the turn", () =>
    Effect.gen(function* () {
      const agents = yield* agentProcesses
      const { provider: make } = setup({ FAKE_ACP_LIFELINE: agents.path })
      const provider = yield* make
      const held = yield* startTurn(provider, input({ prompt: "hold" }))
      yield* held.until((event) => event.type === "tool_call_started")
      yield* provider.interrupt("t1")
      yield* Fiber.join(held.fiber)
      yield* agents.allExited
    }).pipe(Effect.scoped),
  )

  it.live("registers the turn's agent process with its thread, so the ports it opens show there", () =>
    Effect.gen(function* () {
      const { provider: make } = setup()
      const provider = yield* make
      const held = yield* startTurn(provider, input({ threadId: "ports", prompt: "hold" }))
      yield* held.until((event) => event.type === "tool_call_started")
      const agentPids = [...agentPidsOf("ports")]
      expect(agentPids).toHaveLength(1)
      expect(agentPids[0]).not.toBe(process.pid)
      yield* provider.interrupt("ports")
      yield* Fiber.join(held.fiber)
      expect([...agentPidsOf("ports")]).toStrictEqual([])
    }).pipe(Effect.scoped),
  )

  it.effect("gives up on an agent that never answers initialize, and stops it", () =>
    Effect.gen(function* () {
      const agents = yield* agentProcesses
      const { provider: make, logPath } = setup({ FAKE_ACP_LIFELINE: agents.path, FAKE_ACP_SILENT_INITIALIZE: "1" })
      const provider = yield* make
      const turn = yield* startTurn(provider, input())
      yield* logged(logPath, "initialize")
      yield* TestClock.adjust("31 seconds")
      const error = yield* Fiber.join(turn.fiber).pipe(Effect.flip)
      expect(error.message).toMatch(/did not answer initialize/)
      expect(turn.events).toStrictEqual([])
      yield* agents.allExited
    }).pipe(Effect.scoped),
  )
})
