import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, PubSub, Stream } from "effect"
import type { AgentEvent, RunTurnInput } from "../../../shared/agent.ts"
import type { AccessMode } from "../../../shared/domain.ts"
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

const setup = (env: Record<string, string> = {}, authMethod: string | null = null) => {
  const logPath = join(mkdtempSync(join(tmpdir(), "kk-fake-acp-")), "log.jsonl")
  writeFileSync(logPath, "")
  const provider = makeAcpProvider({
    id: "opencode",
    binary: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_ACP_LOG: logPath, ...env },
    authMethod,
    loginCommand: "fake login",
    account: Effect.succeed({ type: "external", service: "fake" }),
  })
  const received = (): Array<Logged> =>
    readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  return { provider, received }
}

const input = (fields: Partial<RunTurnInput> = {}): RunTurnInput => ({
  threadId: "t1",
  prompt: "hello",
  attachments: [],
  cwd: tmpdir(),
  model: "fake/default",
  effort: null,
  fastMode: false,
  autoCompactTokens: null,
  userSkills: true,
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
          { type: "text", text: "You run inside HinaCode." },
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
      expect(yield* provider.listCommands({ threadId: "t2", cwd: tmpdir(), home: null })).toStrictEqual([])
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

  it.live("starts a new session when the agent cannot load the old one", () =>
    Effect.gen(function* () {
      const { provider: make } = setup()
      const provider = yield* make
      const events = yield* runToEnd(provider, input({ resumeSessionId: "ses_missing" }))
      expect(events[0]).toStrictEqual({ type: "session_bound", providerSessionId: "ses_1" })
    }).pipe(Effect.scoped),
  )

  it.live("lists models from configOptions with the agent's default first", () =>
    Effect.gen(function* () {
      const { provider: make, received } = setup()
      const provider = yield* make
      const models = yield* provider.listModels
      expect(models.map((model) => [model.id, model.label])).toStrictEqual([
        ["fake/default", "Fake Default"],
        ["fake/other", "Fake Other"],
      ])
      yield* provider.listModels
      expect(received().filter((message) => message.method === "session/new")).toHaveLength(1)
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
      ])
    }).pipe(Effect.scoped),
  )

  it.live("tells the developer how to sign in when the agent requires it", () =>
    Effect.gen(function* () {
      const { provider: make } = setup({ FAKE_ACP_AUTH: "required" })
      const provider = yield* make
      const error = yield* runToEnd(provider, input()).pipe(Effect.flip)
      expect(error.message).toBe("opencode is not signed in. Run `fake login` in a terminal, then try again")
    }).pipe(Effect.scoped),
  )

  it.live("authenticates and retries when the agent asks for it", () =>
    Effect.gen(function* () {
      const { provider: make, received } = setup({ FAKE_ACP_AUTH: "required" }, "fake_login")
      const provider = yield* make
      const events = yield* runToEnd(provider, input())
      expect(events.at(-1)?.type).toBe("turn_completed")
      expect(
        received()
          .filter((message) => message.method !== undefined)
          .map((message) => message.method),
      ).toStrictEqual(["initialize", "session/new", "authenticate", "session/new", "session/prompt"])
    }).pipe(Effect.scoped),
  )

  it.live("refuses to steer and to use an added account", () =>
    Effect.gen(function* () {
      const { provider: make } = setup()
      const provider = yield* make
      const steer = yield* provider.steer("t1", "more", []).pipe(Effect.flip)
      expect(steer.message).toBe("opencode cannot add to a running turn. Queue the message instead")
      const account = yield* provider.account({ dir: "/tmp/x", binary: "opencode" }).pipe(Effect.flip)
      expect(account.message).toBe("opencode runs on its CLI login only")
      expect(yield* provider.account(null)).toStrictEqual({ type: "external", service: "fake" })
    }).pipe(Effect.scoped),
  )

  it.live("closes the thread's session", () =>
    Effect.gen(function* () {
      const { provider: make, received } = setup()
      const provider = yield* make
      yield* runToEnd(provider, input())
      yield* provider.closeSession!("t1", null)
      expect(received().find((message) => message.method === "session/close")?.params).toStrictEqual({
        sessionId: "ses_1",
      })
      expect(yield* provider.listCommands({ threadId: "t1", cwd: tmpdir(), home: null })).toStrictEqual([])
    }).pipe(Effect.scoped),
  )
})
