import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, PubSub, Scope, Stream } from "effect"
import type { AgentEvent, ProviderId, RunTurnInput } from "../../../shared/agent.ts"
import { agentPidsOf } from "../../services/Ports.ts"
import { AgentBinaries } from "../binary.ts"
import type { AgentProvider } from "../provider.ts"
import { makePiProvider } from "./provider.ts"

const FAKE_PI = join(import.meta.dirname, "fakePi.ts")

type Logged =
  | {
      kind: "start"
      argv: Array<string>
      cwd: string
      env: Record<string, string | undefined>
    }
  | {
      kind: "in"
      command: { id?: string; type: string; message?: string; value?: string; confirmed?: boolean; cancelled?: true }
    }

const withPi = <A, E>(test: (pi: AgentProvider, received: () => Array<Logged>) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "kk-fake-pi-"))
    const logPath = join(dir, "log.jsonl")
    writeFileSync(logPath, "")
    const binary = join(dir, "pi")
    writeFileSync(binary, `#!/bin/sh\nFAKE_PI_LOG='${logPath}' exec '${process.execPath}' '${FAKE_PI}' "$@"\n`, {
      mode: 0o755,
    })
    const received = (): Array<Logged> =>
      readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    const pi = yield* makePiProvider
    return yield* test(pi, received).pipe(
      Effect.provideService(AgentBinaries, {
        configured: Effect.succeed({ pi: binary }),
        simulated: new Set<ProviderId>(),
      }),
    )
  }).pipe(Effect.scoped)

const cwd = mkdtempSync(join(tmpdir(), "kk-pi-project-"))

const input = (fields: Partial<RunTurnInput> = {}): RunTurnInput => ({
  threadId: "t1",
  prompt: "hello",
  attachments: [],
  cwd,
  tmpDirectory: null,
  model: "fake/fake-model",
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

const startTurn = (provider: AgentProvider, turn: RunTurnInput) =>
  Effect.gen(function* () {
    const events: Array<AgentEvent> = []
    const arrived = yield* PubSub.unbounded<AgentEvent>()
    const fiber = yield* provider.runTurn(turn).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => events.push(event)).pipe(Effect.andThen(PubSub.publish(arrived, event))),
      ),
      Effect.forkChild,
    )
    const until = <T extends AgentEvent["type"]>(type: T) =>
      Effect.gen(function* () {
        const updates = yield* PubSub.subscribe(arrived)
        const seen = events.find((event) => event.type === type)
        if (seen !== undefined) return seen as Extract<AgentEvent, { type: T }>
        while (true) {
          const event = yield* PubSub.take(updates)
          if (event.type === type) return event as Extract<AgentEvent, { type: T }>
        }
      }).pipe(Effect.scoped)
    return { fiber, events, until }
  })

const runToEnd = (provider: AgentProvider, turn: RunTurnInput) =>
  provider.runTurn(turn).pipe(
    Stream.runCollect,
    Effect.map((chunk) => [...chunk]),
  )

const types = (events: ReadonlyArray<AgentEvent>) => events.map((event) => event.type)

const commands = (received: () => Array<Logged>) =>
  received().flatMap((record) => (record.kind === "in" ? [record.command] : []))

const starts = (received: () => Array<Logged>) =>
  received().flatMap((record) => (record.kind === "start" ? [record] : []))

describe("makePiProvider", () => {
  it.live("streams a turn with thinking and text, and reports usage, cost and the context window", () =>
    withPi((pi, received) =>
      Effect.gen(function* () {
        const events = yield* runToEnd(pi, input())
        expect(events).toStrictEqual([
          { type: "session_bound", providerSessionId: "ses_new" },
          { type: "reasoning_delta", text: "Thinking" },
          { type: "text_delta", text: "echo: hello" },
          { type: "text_delta", text: " end" },
          {
            type: "turn_completed",
            usage: {
              inputTokens: 115,
              outputTokens: 3,
              costUsd: 0.01,
              context: { usedTokens: 118, maxTokens: 200000 },
            },
          },
        ])
        const [start] = starts(received)
        expect(start?.cwd).toBe(cwd)
        expect(start?.argv).toStrictEqual([
          "--mode",
          "rpc",
          "--approve",
          "-e",
          expect.stringMatching(/hinacode-pi-\w+\/hinacode\.mjs$/),
          "--provider",
          "fake",
          "--model",
          "fake-model",
          "--append-system-prompt",
          "You run inside HinaCode.",
        ])
        expect(readFileSync(start!.argv[4]!, "utf8")).toContain('pi.on("tool_call"')
        expect(start?.env).toMatchObject({
          HINACODE_MCP_URL: "http://127.0.0.1:9/mcp",
          HINACODE_MCP_AUTHORIZATION: "Bearer test",
        })
        expect(commands(received).find((command) => command.type === "prompt")).toMatchObject({
          message: "hello",
        })
      }),
    ),
  )

  it.live("resumes with --session, passes the effort and keeps a model id that has slashes and colons", () =>
    withPi((pi, received) =>
      Effect.gen(function* () {
        const events = yield* runToEnd(
          pi,
          input({ resumeSessionId: "ses_old", effort: "high", model: "openrouter/qwen/qwen3:free" }),
        )
        expect(events[0]).toStrictEqual({ type: "session_bound", providerSessionId: "ses_old" })
        const [start] = starts(received)
        expect(start?.argv.slice(5, -2)).toStrictEqual([
          "--provider",
          "openrouter",
          "--model",
          "qwen/qwen3:free",
          "--thinking",
          "high",
          "--session",
          "ses_old",
        ])
      }),
    ),
  )

  it.live("fails with sessionLost when pi no longer has the session", () =>
    withPi((pi, received) =>
      Effect.gen(function* () {
        const events = yield* runToEnd(pi, input({ resumeSessionId: "ses_missing" }))
        expect(events).toStrictEqual([
          {
            type: "turn_failed",
            message: "No session found matching 'ses_missing'\n\nYour next message starts a new pi session.",
            sessionLost: true,
          },
        ])
        expect(commands(received).filter((command) => command.type === "prompt")).toStrictEqual([])
      }),
    ),
  )

  it.live("fails with sessionLost when the session belongs to another folder", () =>
    withPi((pi) =>
      Effect.gen(function* () {
        const events = yield* runToEnd(pi, input({ resumeSessionId: "ses_elsewhere" }))
        expect(events).toStrictEqual([
          {
            type: "turn_failed",
            message: "Session found in different project: /elsewhere\n\nYour next message starts a new pi session.",
            sessionLost: true,
          },
        ])
      }),
    ),
  )

  it.live("asks before a supervised edit, then reports the file it changed with pi's patch", () =>
    withPi((pi, received) =>
      Effect.gen(function* () {
        const turn = yield* startTurn(pi, input({ prompt: "edit" }))
        const requested = yield* turn.until("approval_requested")
        expect(requested.request).toStrictEqual({
          id: expect.any(String),
          threadId: "t1",
          provider: "pi",
          kind: "patch",
          title: "Edit file",
          detail: "a.txt",
          input: {
            path: "a.txt",
            edits: [{ oldText: "hello", newText: "goodbye" }],
            file_path: join(cwd, "a.txt"),
          },
          sessionScope: { tool: "Edit", kind: "tool", value: "Edit" },
        })
        yield* pi.respondApproval(requested.request.id, "allow")
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
        expect(turn.events).toContainEqual({
          type: "tool_call_started",
          callId: "call_edit",
          name: "Edit",
          input: requested.request.input,
        })
        expect(turn.events).toContainEqual({
          type: "file_changed",
          path: join(cwd, "a.txt"),
          diff: "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-hello\n+goodbye\n",
        })
        expect(turn.events.at(-1)).toMatchObject({ usage: { inputTokens: 240, outputTokens: 7, costUsd: 0.03 } })
        expect(commands(received).filter((command) => command.type === "extension_ui_response")).toStrictEqual([
          { type: "extension_ui_response", id: "ui-0", value: "allow" },
        ])
      }),
    ),
  )

  for (const [accessMode, prompt] of [
    ["supervised", "read"],
    ["auto", "edit"],
    ["full", "bash"],
  ] as const) {
    it.live(`answers a ${prompt} call itself in ${accessMode} mode`, () =>
      withPi((pi, received) =>
        Effect.gen(function* () {
          const events = yield* runToEnd(pi, input({ prompt, accessMode }))
          expect(types(events)).not.toContain("approval_requested")
          expect(events).toContainEqual({
            type: "tool_call_finished",
            callId: `call_${prompt}`,
            output: `${prompt} ok`,
            isError: false,
          })
          expect(commands(received).filter((command) => command.type === "extension_ui_response")).toStrictEqual([
            { type: "extension_ui_response", id: "ui-0", value: "allow" },
          ])
        }),
      ),
    )
  }

  it.live("asks before a command in auto mode, and blocks it when denied", () =>
    withPi((pi, received) =>
      Effect.gen(function* () {
        const turn = yield* startTurn(pi, input({ prompt: "bash", accessMode: "auto" }))
        const requested = yield* turn.until("approval_requested")
        expect(requested.request).toMatchObject({
          kind: "command",
          title: "Run command",
          detail: "rm -rf build",
          sessionScope: { tool: "Bash", kind: "command", value: "rm -rf build" },
        })
        yield* pi.respondApproval(requested.request.id, "deny")
        yield* Fiber.join(turn.fiber)
        expect(turn.events).toContainEqual({
          type: "tool_call_finished",
          callId: "call_bash",
          output: "The user denied this tool call",
          isError: true,
        })
        expect(commands(received).find((command) => command.type === "extension_ui_response")).toMatchObject({
          value: "deny",
        })
      }),
    ),
  )

  it.live("remembers a command allowed for the session, for that thread only", () =>
    withPi((pi) =>
      Effect.gen(function* () {
        const first = yield* startTurn(pi, input({ prompt: "bash" }))
        const requested = yield* first.until("approval_requested")
        yield* pi.respondApproval(requested.request.id, "allow_for_session")
        yield* Fiber.join(first.fiber)

        const again = yield* runToEnd(pi, input({ prompt: "bash", resumeSessionId: "ses_new" }))
        expect(types(again)).not.toContain("approval_requested")

        const other = yield* startTurn(pi, input({ threadId: "t2", prompt: "bash" }))
        const asked = yield* other.until("approval_requested")
        yield* pi.respondApproval(asked.request.id, "allow")
        yield* Fiber.join(other.fiber)
      }),
    ),
  )

  it.live("shows a third-party extension's select and confirm as questions and sends back the answers", () =>
    withPi((pi, received) =>
      Effect.gen(function* () {
        const turn = yield* startTurn(pi, input({ prompt: "ask" }))
        const select = yield* turn.until("question_requested")
        expect(select.request).toStrictEqual({
          id: "ui-0",
          threadId: "t1",
          provider: "pi",
          questions: [
            {
              id: "ui-0",
              header: "",
              question: "Pick a color",
              options: [
                { label: "red", description: "" },
                { label: "blue", description: "" },
              ],
              multiSelect: false,
              allowsText: false,
              secret: false,
            },
          ],
        })
        yield* pi.respondQuestion("ui-0", { "ui-0": ["red"] })
        yield* turn.until("question_resolved")
        const confirm = yield* Effect.gen(function* () {
          while (true) {
            const asked = turn.events.filter((event) => event.type === "question_requested")
            if (asked.length === 2) return asked[1]!
            yield* Effect.sleep("10 millis")
          }
        })
        expect(confirm.request.questions[0]).toMatchObject({
          question: "Paint it?\n\nThis repaints the wall.",
          options: [
            { label: "Yes", description: "" },
            { label: "No", description: "" },
          ],
        })
        yield* pi.respondQuestion("ui-1", { "ui-1": ["Yes"] })
        yield* Fiber.join(turn.fiber)
        expect(turn.events).toContainEqual({ type: "text_delta", text: "picked red, confirmed true" })
        expect(commands(received).filter((command) => command.type === "extension_ui_response")).toStrictEqual([
          { type: "extension_ui_response", id: "ui-0", value: "red" },
          { type: "extension_ui_response", id: "ui-1", confirmed: true },
        ])
      }),
    ),
  )

  it.live("steers a running turn", () =>
    withPi((pi, received) =>
      Effect.gen(function* () {
        expect(yield* pi.steer!("t1", "too early", [], "now")).toBe(false)
        const turn = yield* startTurn(pi, input({ prompt: "steer" }))
        yield* turn.until("text_delta")
        expect(yield* pi.steer!("t1", "use tabs", [], "now")).toBe(true)
        yield* Fiber.join(turn.fiber)
        expect(turn.events).toContainEqual({ type: "text_delta", text: " steered: use tabs" })
        expect(commands(received).find((command) => command.type === "steer")).toMatchObject({ message: "use tabs" })
      }),
    ),
  )

  it.live("refuses a steer that pi took after it settled, so the runner sends it to the next turn", () =>
    withPi((pi) =>
      Effect.gen(function* () {
        const turn = yield* startTurn(pi, input({ prompt: "late-steer" }))
        yield* turn.until("text_delta")
        expect(yield* pi.steer!("t1", "one more thing", [], "now")).toBe(false)
        yield* Fiber.join(turn.fiber)
        expect(turn.events.at(-1)).toMatchObject({ type: "turn_completed" })
      }),
    ),
  )

  it.live("completes a prompt an extension handled without starting a run", () =>
    withPi((pi) =>
      Effect.gen(function* () {
        const events = yield* runToEnd(pi, input({ prompt: "/handled" }))
        expect(events.slice(1)).toStrictEqual([{ type: "turn_completed" }])
      }),
    ),
  )

  it.live("answers an extension dialog that pi shows before it accepts the prompt", () =>
    withPi((pi) =>
      Effect.gen(function* () {
        const turn = yield* startTurn(pi, input({ prompt: "preflight" }))
        const asked = yield* turn.until("question_requested")
        const [question] = asked.request.questions
        yield* pi.respondQuestion(asked.request.id, { [question!.id]: ["ABC-7"] })
        yield* Fiber.join(turn.fiber)
        expect(turn.events).toContainEqual({ type: "text_delta", text: "echo: echo ABC-7" })
      }),
    ),
  )

  it.live("refuses to prompt when pi did not load HinaCode's extension", () =>
    withPi((pi, received) =>
      Effect.gen(function* () {
        const failure = yield* runToEnd(pi, input({ resumeSessionId: "ses_old_pi" })).pipe(Effect.flip)
        expect(failure.message).toContain("did not load HinaCode's extension")
        expect(commands(received).filter((command) => command.type === "prompt")).toStrictEqual([])
      }),
    ),
  )

  it.live("interrupts with clear_queue and abort, closes the open tool and ends the turn interrupted", () =>
    withPi((pi, received) =>
      Effect.gen(function* () {
        const turn = yield* startTurn(pi, input({ threadId: "ports", prompt: "hold" }))
        yield* turn.until("tool_call_started")
        const [pid] = [...agentPidsOf("ports")]
        expect(pid).toBeTypeOf("number")
        yield* pi.interrupt("ports")
        yield* Fiber.join(turn.fiber)
        expect(turn.events.slice(1)).toStrictEqual([
          { type: "tool_call_started", callId: "call_sleep", name: "Bash", input: { command: "sleep 60" } },
          { type: "tool_call_finished", callId: "call_sleep", output: "Interrupted", isError: true },
          { type: "turn_failed", message: "Turn interrupted" },
        ])
        expect(
          commands(received)
            .map((command) => command.type)
            .filter((type) => type === "clear_queue" || type === "abort"),
        ).toStrictEqual(["clear_queue", "abort"])
        expect([...agentPidsOf("ports")]).toStrictEqual([])
        expect(() => process.kill(pid!, 0)).toThrow()
      }),
    ),
  )

  it.live("fails an error stop with pi's message, and asks to sign in when it is an auth problem", () =>
    withPi((pi) =>
      Effect.gen(function* () {
        const auth = yield* runToEnd(pi, input({ prompt: "error" }))
        expect(auth.at(-1)).toStrictEqual({
          type: "turn_failed",
          message: "OAuth refresh failed for anthropic: invalid_grant",
          signedOut: true,
          loginCommand: "pi auth login",
        })
        const overloaded = yield* runToEnd(pi, input({ prompt: "overloaded" }))
        expect(overloaded.at(-1)).toStrictEqual({ type: "turn_failed", message: "529 overloaded_error: Overloaded" })
      }),
    ),
  )

  it.live("fails the turn with pi's last words when it exits mid-turn, closing its open tool", () =>
    withPi((pi) =>
      Effect.gen(function* () {
        const turn = yield* startTurn(pi, input({ prompt: "crash" }))
        const error = yield* Fiber.join(turn.fiber).pipe(Effect.flip)
        expect(error.message).toBe("pi exited (code 3). fatal: out of memory")
        expect(turn.events.at(-1)).toStrictEqual({
          type: "tool_call_finished",
          callId: "call_build",
          output: "Turn failed",
          isError: true,
        })
      }),
    ),
  )

  it.live("runs pi with the thread's tmp folder", () =>
    withPi((pi) =>
      Effect.gen(function* () {
        const threadTmp = mkdtempSync(join(tmpdir(), "hc-thread-"))
        const events = yield* runToEnd(pi, input({ prompt: "tmp", tmpDirectory: threadTmp }))
        expect(events).toContainEqual({ type: "text_delta", text: threadTmp })
      }),
    ),
  )

  it.live("lists models with pi's current model first, and commands once per folder", () =>
    withPi((pi, received) =>
      Effect.gen(function* () {
        const models = yield* pi.listModels
        expect(models.map((model) => [model.id, model.label, model.efforts, model.defaultEffort])).toStrictEqual([
          ["fake/fake-model", "fake/Fake Model", ["off", "minimal", "low", "medium", "high"], "medium"],
          ["fake/plain", "fake/Plain", [], null],
        ])
        yield* pi.listModels
        const project = mkdtempSync(join(tmpdir(), "kk-pi-commands-"))
        const listed = yield* pi.listCommands({ threadId: "t1", cwd: project, home: null })
        yield* pi.listCommands({ threadId: "t2", cwd: project, home: null })
        expect(listed).toStrictEqual([
          { trigger: "/", name: "review", description: "Review the diff", argumentHint: "" },
          { trigger: "/", name: "skill:docs", description: "", argumentHint: "" },
        ])
        expect(starts(received).map((start) => [start.argv, start.cwd === project])).toStrictEqual([
          [["--mode", "rpc", "--approve", "--no-session"], false],
          [["--mode", "rpc", "--approve", "--no-session"], true],
        ])
      }),
    ),
  )

  it.live("runs on the CLI login only", () =>
    withPi((pi) =>
      Effect.gen(function* () {
        expect(yield* pi.account(null)).toStrictEqual({ type: "external", service: "pi" })
        const refused = yield* pi.account({ dir: "/tmp/x", binary: "pi" }).pipe(Effect.flip)
        expect(refused.message).toBe("pi runs on its CLI login only")
        const turn = yield* runToEnd(pi, input({ home: { dir: "/tmp/x", binary: "pi" } })).pipe(Effect.flip)
        expect(turn.message).toBe("pi runs on its CLI login only")
      }),
    ),
  )
})
