import type { Options, PermissionResult, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { AgentEvent, RunTurnInput } from "../../../shared/agent.ts"
import { usageLimitResult } from "./fixtures/usageLimit.ts"
import { ClaudeProvider, layer } from "./index.ts"

const sdk = vi.hoisted(() => {
  type Message = { readonly type: string } & Readonly<Record<string, unknown>>

  /** A CLI whose output the test writes, answering each prompt through `sdk.respond`. */
  class FakeQuery {
    readonly options: Options
    readonly prompts: Array<SDKUserMessage> = []
    readonly close = vi.fn(() => this.end())
    readonly setModel = vi.fn((_model: string) => sdk.setModel())
    readonly applyFlagSettings = vi.fn(() => Promise.resolve())
    readonly setPermissionMode = vi.fn((_mode: string) => sdk.setPermissionMode())
    readonly interrupt = vi.fn(() => Promise.resolve())
    readonly supportedCommands = vi.fn(() => sdk.supportedCommands())
    readonly supportedModels = vi.fn(() => sdk.supportedModels())
    private readonly buffer: Array<Message> = []
    private reader: ((result: IteratorResult<Message>) => void) | null = null
    private ended = false

    constructor(input: { readonly prompt: AsyncIterable<SDKUserMessage>; readonly options: Options }) {
      this.options = input.options
      // The prompt stream fails once the session's queue shuts down, which is how a closed session ends it.
      this.read(input.prompt).catch(() => undefined)
    }

    private async read(prompt: AsyncIterable<SDKUserMessage>) {
      for await (const message of prompt) {
        this.prompts.push(message)
        await sdk.respond(this)
      }
    }

    push(...messages: ReadonlyArray<Message>) {
      for (const message of messages) {
        if (this.reader === null) this.buffer.push(message)
        else {
          this.reader({ done: false, value: message })
          this.reader = null
        }
      }
    }

    askTool(toolName: string, input: Record<string, unknown>): Promise<PermissionResult | null> {
      const canUseTool = this.options.canUseTool
      if (canUseTool === undefined) throw new Error("canUseTool is not set")
      return canUseTool(toolName, input, {
        signal: new AbortController().signal,
        toolUseID: `tool-${this.prompts.length}`,
        requestId: `request-${this.prompts.length}`,
      })
    }

    next(): Promise<IteratorResult<Message>> {
      const message = this.buffer.shift()
      if (message !== undefined) return Promise.resolve({ done: false, value: message })
      if (this.ended) return Promise.resolve({ done: true, value: undefined })
      return new Promise((resolve) => (this.reader = resolve))
    }

    return(): Promise<IteratorResult<Message>> {
      this.end()
      return Promise.resolve({ done: true, value: undefined })
    }

    private end() {
      this.ended = true
      this.reader?.({ done: true, value: undefined })
      this.reader = null
    }
  }

  const state = {
    clis: new Array<FakeQuery>(),
    respond: (_cli: FakeQuery): void | Promise<void> => undefined,
    setModel: (): Promise<void> => Promise.resolve(),
    setPermissionMode: (): Promise<void> => Promise.resolve(),
    supportedCommands: (): Promise<Array<never>> => Promise.resolve([]),
    supportedModels: (): Promise<Array<never>> => Promise.resolve([]),
    FakeQuery,
  }
  return state
})

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (input: { readonly prompt: AsyncIterable<SDKUserMessage>; readonly options: Options }) => {
    const cli = new sdk.FakeQuery(input)
    sdk.clis.push(cli)
    return cli
  },
  tool: vi.fn(),
  createSdkMcpServer: vi.fn(),
}))

const TTL = "60 seconds"

const init = (sessionId: string) => ({ type: "system", subtype: "init", session_id: sessionId })
const succeeded = { ...usageLimitResult, is_error: false, result: "done" }
const failed = { ...usageLimitResult, result: "Something broke" }
const limited = usageLimitResult
const taskStarted = (taskId: string, extra: Readonly<Record<string, unknown>> = {}) => ({
  type: "system",
  subtype: "task_started",
  task_id: taskId,
  description: "npm run dev",
  task_type: "local_bash",
  is_backgrounded: true,
  ...extra,
})
const taskNotification = (taskId: string, extra: Readonly<Record<string, unknown>> = {}) => ({
  type: "system",
  subtype: "task_notification",
  task_id: taskId,
  status: "completed",
  output_file: "/tmp/out",
  summary: "",
  ...extra,
})
const backgroundTasks = (...tasks: ReadonlyArray<Readonly<Record<string, unknown>>>) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: tasks.map((task) => ({ task_type: "local_bash", description: "npm run dev", ...task })),
})

const turnInput = (overrides: Partial<RunTurnInput> = {}): RunTurnInput => ({
  threadId: "thread-1",
  prompt: "Hello",
  attachments: [],
  cwd: "/repo",
  model: "claude-sonnet-5-5",
  effort: null,
  fastMode: false,
  accessMode: "supervised",
  resumeSessionId: null,
  home: null,
  mcpServer: { url: "http://127.0.0.1:1/mcp", headers: { authorization: "Bearer test" } },
  instructions: "Work in kkcode",
  ...overrides,
})

/** Lets promise callbacks and forked fibers run; TestClock only moves Effect's own clock. */
const tick = Effect.yieldNow
const settle = Effect.gen(function* () {
  for (let i = 0; i < 5; i++) yield* tick
})
const until = (ready: () => boolean) =>
  Effect.gen(function* () {
    while (!ready()) yield* tick
  })

const latestCli = () => {
  const cli = sdk.clis.at(-1)
  if (cli === undefined) throw new Error("No CLI was started")
  return cli
}

const completeWith =
  (result: typeof limited, sessionId = "session-1") =>
  (cli: InstanceType<typeof sdk.FakeQuery>) =>
    cli.push(init(sessionId), result)

const runTurn = (input: RunTurnInput = turnInput()) =>
  Effect.gen(function* () {
    const provider = yield* ClaudeProvider
    const events = yield* provider.runTurn(input).pipe(Stream.runCollect)
    yield* settle
    return events
  })

/** Runs a turn in the background, so the test can act while it is open. */
const startTurn = (input: RunTurnInput = turnInput()) =>
  Effect.gen(function* () {
    const provider = yield* ClaudeProvider
    const events: Array<AgentEvent> = []
    const fiber = yield* provider.runTurn(input).pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.forkChild,
    )
    return { events, fiber }
  })

const lifecycle = <A, E>(effect: Effect.Effect<A, E, ClaudeProvider>) =>
  Effect.suspend(() => {
    sdk.clis.length = 0
    sdk.respond = completeWith(succeeded)
    sdk.setModel = () => Promise.resolve()
    sdk.setPermissionMode = () => Promise.resolve()
    sdk.supportedCommands = () => Promise.resolve([])
    sdk.supportedModels = () => Promise.resolve([])
    return effect
  }).pipe(Effect.provide(layer))

describe("Claude idle sessions", () => {
  for (const [outcome, result] of [
    ["completed", succeeded],
    ["failed", failed],
    ["limited", limited],
  ] as const) {
    it.effect(`closes the CLI 60 seconds after a ${outcome} turn and resumes it on the next prompt`, () =>
      lifecycle(
        Effect.gen(function* () {
          sdk.respond = completeWith(result)
          yield* runTurn()
          const first = latestCli()

          yield* TestClock.adjust("59 seconds")
          expect(first.close).not.toHaveBeenCalled()
          yield* TestClock.adjust("1 second")
          yield* settle
          expect(first.close).toHaveBeenCalledOnce()

          sdk.respond = completeWith(succeeded)
          yield* runTurn()
          expect(sdk.clis).toHaveLength(2)
          expect(latestCli().options.resume).toBe("session-1")
        }),
      ),
    )
  }

  it.effect("reuses a session prompted before its deadline and restarts the countdown when that turn ends", () =>
    lifecycle(
      Effect.gen(function* () {
        yield* runTurn()
        yield* TestClock.adjust("30 seconds")
        yield* runTurn()
        expect(sdk.clis).toHaveLength(1)

        yield* TestClock.adjust("59 seconds")
        expect(latestCli().close).not.toHaveBeenCalled()
        yield* TestClock.adjust("1 second")
        yield* settle
        expect(latestCli().close).toHaveBeenCalledOnce()
      }),
    ),
  )

  it.effect("keeps a session whose model switch is still in flight past the old deadline", () =>
    lifecycle(
      Effect.gen(function* () {
        yield* runTurn()
        yield* TestClock.adjust("30 seconds")
        const modelSwitch = Promise.withResolvers<void>()
        sdk.setModel = () => modelSwitch.promise
        const turn = yield* startTurn(turnInput({ model: "claude-opus-5-5" }))
        yield* until(() => latestCli().setModel.mock.calls.length === 1)

        yield* TestClock.adjust("10 minutes")
        expect(latestCli().close).not.toHaveBeenCalled()

        modelSwitch.resolve()
        yield* Fiber.join(turn.fiber)
        expect(turn.events.at(-1)?.type).toBe("turn_completed")
        expect(sdk.clis).toHaveLength(1)
      }),
    ),
  )

  it.effect("still expires a session whose turn failed before reaching the CLI", () =>
    lifecycle(
      Effect.gen(function* () {
        yield* runTurn()
        sdk.setModel = () => Promise.reject(new Error("model unavailable"))
        const provider = yield* ClaudeProvider
        const error = yield* provider
          .runTurn(turnInput({ model: "claude-opus-5-5" }))
          .pipe(Stream.runCollect, Effect.flip)
        expect(error.message).toContain("model unavailable")
        yield* settle

        yield* TestClock.adjust(TTL)
        yield* settle
        expect(latestCli().close).toHaveBeenCalledOnce()
      }),
    ),
  )

  it.effect("keeps a session while an approval is pending, and remembers 'allow for session' after expiry", () =>
    lifecycle(
      Effect.gen(function* () {
        const provider = yield* ClaudeProvider
        const decisions: Array<PermissionResult | null> = []
        sdk.respond = async (cli) => {
          cli.push(init("session-1"))
          decisions.push(await cli.askTool("Bash", { command: "pnpm test" }))
          cli.push(succeeded)
        }
        const turn = yield* startTurn(
          turnInput({
            attachments: [
              { id: "a1", name: "notes.md", path: "/tmp/notes.md", mime: "text/markdown", kind: "file", bytes: 10 },
            ],
          }),
        )
        yield* until(() => turn.events.some((event) => event.type === "approval_requested"))

        yield* TestClock.adjust("10 minutes")
        expect(latestCli().close).not.toHaveBeenCalled()

        const request = turn.events.find((event) => event.type === "approval_requested")
        if (request?.type !== "approval_requested") throw new Error("No approval was requested")
        yield* provider.respondApproval(request.request.id, "allow_for_session")
        yield* Fiber.join(turn.fiber)
        yield* settle
        yield* TestClock.adjust(TTL)
        yield* settle
        expect(latestCli().close).toHaveBeenCalledOnce()

        sdk.respond = async (cli) => {
          cli.push(init("session-1"))
          decisions.push(await cli.askTool("Bash", { command: "pnpm test" }))
          decisions.push(await cli.askTool("Read", { file_path: "/tmp/notes.md" }))
          cli.push(succeeded)
        }
        const resumed = yield* runTurn()
        expect(sdk.clis).toHaveLength(2)
        expect(resumed.some((event) => event.type === "approval_requested")).toBe(false)
        expect(decisions.map((decision) => decision?.behavior)).toStrictEqual(["allow", "allow", "allow"])
      }),
    ),
  )

  it.effect("asks again for a session grant once the thread moves to another directory", () =>
    lifecycle(
      Effect.gen(function* () {
        const provider = yield* ClaudeProvider
        sdk.respond = async (cli) => {
          cli.push(init("session-1"))
          await cli.askTool("Bash", { command: "pnpm test" })
          cli.push(succeeded)
        }
        const first = yield* startTurn()
        yield* until(() => first.events.some((event) => event.type === "approval_requested"))
        const request = first.events.find((event) => event.type === "approval_requested")
        if (request?.type !== "approval_requested") throw new Error("No approval was requested")
        yield* provider.respondApproval(request.request.id, "allow_for_session")
        yield* Fiber.join(first.fiber)
        yield* settle
        yield* TestClock.adjust(TTL)
        yield* settle

        const moved = yield* startTurn(turnInput({ cwd: "/repo-worktree" }))
        yield* until(() => moved.events.some((event) => event.type === "approval_requested"))
        expect(sdk.clis).toHaveLength(2)
        expect(latestCli().options.resume).toBe("session-1")
      }),
    ),
  )

  it.effect("keeps a session while a steered turn is still answering", () =>
    lifecycle(
      Effect.gen(function* () {
        const provider = yield* ClaudeProvider
        sdk.respond = (cli) => {
          if (cli.prompts.length === 1) cli.push(init("session-1"))
        }
        const turn = yield* startTurn()
        yield* until(() => sdk.clis.at(-1)?.prompts.length === 1)
        yield* provider.steer("thread-1", "Use pnpm instead", [])
        yield* until(() => latestCli().prompts.length === 2)
        latestCli().push({ ...succeeded, terminal_reason: "aborted_streaming" })

        yield* TestClock.adjust("10 minutes")
        expect(latestCli().close).not.toHaveBeenCalled()

        latestCli().push(succeeded)
        yield* Fiber.join(turn.fiber)
        expect(turn.events.at(-1)?.type).toBe("turn_completed")
      }),
    ),
  )

  it.effect("waits for an abandoned turn's result before the countdown starts", () =>
    lifecycle(
      Effect.gen(function* () {
        sdk.respond = (cli) => cli.push(init("session-1"))
        const turn = yield* startTurn()
        yield* until(() => turn.events.some((event) => event.type === "session_bound"))
        yield* Fiber.interrupt(turn.fiber)
        yield* settle
        expect(latestCli().interrupt).toHaveBeenCalledOnce()

        yield* TestClock.adjust("10 minutes")
        expect(latestCli().close).not.toHaveBeenCalled()

        latestCli().push(failed)
        yield* settle
        yield* TestClock.adjust("59 seconds")
        expect(latestCli().close).not.toHaveBeenCalled()
        yield* TestClock.adjust("1 second")
        yield* settle
        expect(latestCli().close).toHaveBeenCalledOnce()
      }),
    ),
  )

  it.effect("keeps a session while a background shell started by the turn is running", () =>
    lifecycle(
      Effect.gen(function* () {
        sdk.respond = (cli) => cli.push(init("session-1"), taskStarted("shell-1"), succeeded)
        yield* runTurn()

        yield* TestClock.adjust("10 minutes")
        expect(latestCli().close).not.toHaveBeenCalled()

        latestCli().push(taskNotification("shell-1"))
        yield* settle
        yield* TestClock.adjust("59 seconds")
        expect(latestCli().close).not.toHaveBeenCalled()
        yield* TestClock.adjust("1 second")
        yield* settle
        expect(latestCli().close).toHaveBeenCalledOnce()
      }),
    ),
  )

  it.effect("does not let an ambient task hold the session open", () =>
    lifecycle(
      Effect.gen(function* () {
        sdk.respond = (cli) =>
          cli.push(init("session-1"), taskStarted("watcher", { ambient: true, task_type: "local_workflow" }), succeeded)
        yield* runTurn()

        yield* TestClock.adjust(TTL)
        yield* settle
        expect(latestCli().close).toHaveBeenCalledOnce()
      }),
    ),
  )

  it.effect("restarts the countdown when a background task ends inside the idle deadline", () =>
    lifecycle(
      Effect.gen(function* () {
        yield* runTurn()
        yield* TestClock.adjust("10 seconds")
        latestCli().push(taskStarted("shell-1"))
        yield* settle
        yield* TestClock.adjust("10 seconds")
        latestCli().push(taskNotification("shell-1"))
        yield* settle

        yield* TestClock.adjust("59 seconds")
        expect(latestCli().close).not.toHaveBeenCalled()
        yield* TestClock.adjust("1 second")
        yield* settle
        expect(latestCli().close).toHaveBeenCalledOnce()
      }),
    ),
  )

  it.effect("expires 60 seconds after a background tasks snapshot drops the last task", () =>
    lifecycle(
      Effect.gen(function* () {
        sdk.respond = (cli) => cli.push(init("session-1"), taskStarted("shell-1"), succeeded)
        yield* runTurn()
        yield* TestClock.adjust("10 minutes")
        expect(latestCli().close).not.toHaveBeenCalled()

        latestCli().push(backgroundTasks())
        yield* settle
        yield* TestClock.adjust("59 seconds")
        expect(latestCli().close).not.toHaveBeenCalled()
        yield* TestClock.adjust("1 second")
        yield* settle
        expect(latestCli().close).toHaveBeenCalledOnce()
      }),
    ),
  )

  it.effect("keeps a session while a background tasks snapshot lists a live task", () =>
    lifecycle(
      Effect.gen(function* () {
        sdk.respond = (cli) =>
          cli.push(
            init("session-1"),
            backgroundTasks({ task_id: "shell-1" }, { task_id: "watcher", ambient: true }),
            succeeded,
          )
        yield* runTurn()

        yield* TestClock.adjust("10 minutes")
        expect(latestCli().close).not.toHaveBeenCalled()
      }),
    ),
  )

  it.effect("ignores a late notification from an earlier run of a resumed task", () =>
    lifecycle(
      Effect.gen(function* () {
        sdk.respond = (cli) => cli.push(init("session-1"), taskStarted("agent-1", { run_id: "run-1" }), succeeded)
        yield* runTurn()
        latestCli().push(taskStarted("agent-1", { run_id: "run-2" }), taskNotification("agent-1", { run_id: "run-1" }))
        yield* settle

        yield* TestClock.adjust("10 minutes")
        expect(latestCli().close).not.toHaveBeenCalled()

        latestCli().push(taskNotification("agent-1", { run_id: "run-2" }))
        yield* settle
        yield* TestClock.adjust(TTL)
        yield* settle
        expect(latestCli().close).toHaveBeenCalledOnce()
      }),
    ),
  )

  it.effect("keeps a session while an access mode switch is in flight", () =>
    lifecycle(
      Effect.gen(function* () {
        const provider = yield* ClaudeProvider
        yield* runTurn()
        yield* TestClock.adjust("30 seconds")
        const modeSwitch = Promise.withResolvers<void>()
        sdk.setPermissionMode = () => modeSwitch.promise
        const switching = yield* provider.setAccessMode("thread-1", "full").pipe(Effect.forkChild)
        yield* until(() => latestCli().setPermissionMode.mock.calls.length === 1)

        yield* TestClock.adjust("10 minutes")
        expect(latestCli().close).not.toHaveBeenCalled()

        modeSwitch.resolve()
        yield* Fiber.join(switching)
        yield* settle
        yield* TestClock.adjust(TTL)
        yield* settle
        expect(latestCli().close).toHaveBeenCalledOnce()
      }),
    ),
  )

  it.effect("keeps a session while it is listing its commands", () =>
    lifecycle(
      Effect.gen(function* () {
        const provider = yield* ClaudeProvider
        yield* runTurn()
        yield* TestClock.adjust("30 seconds")
        const listed = Promise.withResolvers<Array<never>>()
        sdk.supportedCommands = () => listed.promise
        const listing = yield* provider
          .listCommands({ threadId: "thread-1", cwd: "/repo", home: null })
          .pipe(Effect.forkChild)
        yield* until(() => latestCli().supportedCommands.mock.calls.length === 1)

        yield* TestClock.adjust("10 minutes")
        expect(latestCli().close).not.toHaveBeenCalled()

        listed.resolve([])
        yield* Fiber.join(listing)
        yield* settle
        yield* TestClock.adjust(TTL)
        yield* settle
        expect(latestCli().close).toHaveBeenCalledOnce()
      }),
    ),
  )

  it.effect("stops a turn whose auto mode check is pending without starting or stranding a CLI", () =>
    lifecycle(
      Effect.gen(function* () {
        sdk.supportedModels = () => new Promise(() => undefined)
        const turn = yield* startTurn(turnInput({ accessMode: "auto" }))
        yield* until(() => sdk.clis.length === 1)

        const stop = yield* Fiber.interrupt(turn.fiber).pipe(Effect.forkChild)
        yield* settle
        expect(stop.pollUnsafe()).toBeDefined()
        expect(sdk.clis).toHaveLength(1)
        expect(latestCli().close).toHaveBeenCalledOnce()

        yield* runTurn()
        yield* TestClock.adjust(TTL)
        yield* settle
        expect(latestCli().close).toHaveBeenCalledOnce()
      }),
    ),
  )
})
