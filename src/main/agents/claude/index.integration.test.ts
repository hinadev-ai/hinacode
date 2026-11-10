import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, PubSub, Stream } from "effect"
import type { AccountHome, AgentEvent, RunTurnInput } from "../../../shared/agent.ts"
import { makeClaudeHarness } from "./index.ts"

const FAKE_CLI = join(import.meta.dirname, "fakeCli.mjs")

const cliProcesses = Effect.acquireRelease(
  Effect.callback<{ readonly path: string; readonly allExited: Effect.Effect<void>; readonly close: () => void }>(
    (resume) => {
      const path = join(mkdtempSync(join(tmpdir(), "hc-claude-lifeline-")), "cli.sock")
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

interface Control {
  readonly lifeline?: string
  readonly exitOnStart?: boolean
  readonly bypassDisabled?: boolean
}

const fakeHome = (control: Control) => {
  const dir = mkdtempSync(join(tmpdir(), "hc-claude-home-"))
  const binary = join(dir, "claude")
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`)
  chmodSync(binary, 0o755)
  const setControl = (next: Control) => writeFileSync(join(dir, "control.json"), JSON.stringify(next))
  setControl(control)
  const received = (): ReadonlyArray<{ readonly type: string; readonly request?: { readonly subtype: string } }> =>
    readFileSync(join(dir, "received.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  return { home: { dir, binary } satisfies AccountHome, setControl, received }
}

const input = (home: AccountHome, fields: Partial<RunTurnInput> = {}): RunTurnInput => ({
  threadId: "t1",
  prompt: "hello",
  attachments: [],
  cwd: tmpdir(),
  tmpDirectory: null,
  model: "claude-sonnet-5-5",
  effort: null,
  fastMode: false,
  autoCompactTokens: null,
  accessMode: "supervised",
  resumeSessionId: null,
  forkAt: null,
  home,
  mcpServer: { url: "http://127.0.0.1:9/mcp", headers: { authorization: "Bearer test" } },
  instructions: "You run inside HinaCode.",
  ...fields,
})

const harness = makeClaudeHarness({
  id: "claude",
  listModels: Effect.succeed([]),
  launchEnv: () => Effect.succeed({}),
})

type Harness = Effect.Success<typeof harness>

const startTurn = (provider: Harness, turn: RunTurnInput) =>
  Effect.gen(function* () {
    const events: Array<AgentEvent> = []
    const arrived = yield* PubSub.unbounded<AgentEvent>()
    const fiber = yield* provider.runTurn(turn).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => events.push(event)).pipe(Effect.andThen(PubSub.publish(arrived, event))),
      ),
      Effect.forkChild,
    )
    const until = <A extends AgentEvent>(predicate: (event: AgentEvent) => event is A) =>
      Effect.gen(function* () {
        const updates = yield* PubSub.subscribe(arrived)
        const seen = events.find(predicate)
        if (seen !== undefined) return seen
        while (true) {
          const event = yield* PubSub.take(updates)
          if (predicate(event)) return event
        }
      }).pipe(Effect.scoped)
    return { events, fiber, until }
  })

const runToEnd = (provider: Harness, turn: RunTurnInput) =>
  Effect.gen(function* () {
    const { events, fiber } = yield* startTurn(provider, turn)
    yield* Fiber.join(fiber)
    return events
  })

const ended = (events: ReadonlyArray<AgentEvent>) => events.at(-1)

const withClis = <A, E>(body: (lifeline: string) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const clis = yield* cliProcesses
    const result = yield* body(clis.path)
    yield* clis.allExited
    return result
  }).pipe(Effect.scoped)

describe("Claude Code CLI failures", () => {
  it.live("fails the turn when the CLI crashes mid-turn, then resumes the session in a new CLI", () =>
    withClis((lifeline) =>
      Effect.gen(function* () {
        const { home } = fakeHome({ lifeline })
        const provider = yield* harness
        const crashed = yield* runToEnd(provider, input(home, { prompt: "crash" }))
        expect(crashed).toContainEqual({ type: "text_delta", text: "half an answer" })
        expect(ended(crashed)).toStrictEqual({
          type: "turn_failed",
          message: expect.stringContaining("Claude Code process exited with code 3"),
        })

        const bound = crashed.find((event) => event.type === "session_bound")
        const next = yield* runToEnd(provider, input(home))
        expect(next).toContainEqual(bound)
        expect(ended(next)).toMatchObject({ type: "turn_completed" })
      }).pipe(Effect.scoped),
    ),
  )

  it.live("fails the turn when the CLI exits before it starts, and the next turn starts a new CLI", () =>
    withClis((lifeline) =>
      Effect.gen(function* () {
        const { home, setControl } = fakeHome({ lifeline, exitOnStart: true })
        const provider = yield* harness
        const failed = yield* runToEnd(provider, input(home))
        expect(failed).toStrictEqual([
          { type: "turn_failed", message: expect.stringContaining("Claude Code process exited with code 1") },
        ])

        setControl({ lifeline })
        expect(ended(yield* runToEnd(provider, input(home)))).toMatchObject({ type: "turn_completed" })
      }).pipe(Effect.scoped),
    ),
  )

  it.live("runs a full access turn when the CLI starts in bypassPermissions", () =>
    withClis((lifeline) =>
      Effect.gen(function* () {
        const { home } = fakeHome({ lifeline })
        const provider = yield* harness
        const events = yield* runToEnd(provider, input(home, { accessMode: "full" }))
        expect(ended(events)).toMatchObject({ type: "turn_completed" })
      }).pipe(Effect.scoped),
    ),
  )

  it.live("fails a full access turn when the CLI's settings disable bypassPermissions", () =>
    withClis((lifeline) =>
      Effect.gen(function* () {
        const { home } = fakeHome({ lifeline, bypassDisabled: true })
        const provider = yield* harness
        const events = yield* runToEnd(provider, input(home, { accessMode: "full" }))
        expect(ended(events)).toStrictEqual({
          type: "turn_failed",
          message: expect.stringContaining("disableBypassPermissionsMode"),
        })
        expect(events.map((event) => event.type)).not.toContain("text_delta")
      }).pipe(Effect.scoped),
    ),
  )

  it.live("keeps a turn switched to full access while the CLI reports the mode it started in", () =>
    withClis((lifeline) =>
      Effect.gen(function* () {
        const { home } = fakeHome({ lifeline })
        const provider = yield* harness
        const turn = yield* startTurn(provider, input(home, { prompt: "init after a mode switch" }))
        yield* turn.until((event) => event.type === "text_delta")
        yield* provider.setAccessMode("t1", "full")
        yield* Fiber.join(turn.fiber)
        expect(ended(turn.events)).toMatchObject({ type: "turn_completed" })
      }).pipe(Effect.scoped),
    ),
  )

  it.live("skips stdout lines that are not JSON and message types it does not know", () =>
    withClis((lifeline) =>
      Effect.gen(function* () {
        const { home } = fakeHome({ lifeline })
        const provider = yield* harness
        const events = yield* runToEnd(provider, input(home, { prompt: "noise" }))
        expect(events.filter((event) => event.type === "text_delta")).toStrictEqual([
          { type: "text_delta", text: "echo: noise" },
        ])
        expect(ended(events)).toMatchObject({ type: "turn_completed" })
      }).pipe(Effect.scoped),
    ),
  )

  it.live("resolves a pending approval when the user stops the turn, and the next turn runs", () =>
    withClis((lifeline) =>
      Effect.gen(function* () {
        const { home } = fakeHome({ lifeline })
        const provider = yield* harness
        const turn = yield* startTurn(provider, input(home, { prompt: "approve" }))
        const { request } = yield* turn.until(
          (event): event is Extract<AgentEvent, { type: "approval_requested" }> => event.type === "approval_requested",
        )
        yield* provider.interrupt("t1")
        yield* Fiber.join(turn.fiber)
        expect(turn.events).toContainEqual({ type: "approval_resolved", requestId: request.id })
        expect(ended(turn.events)).toStrictEqual({ type: "turn_failed", message: "Interrupted" })
        expect(yield* provider.respondApproval(request.id, "allow")).toBe(false)

        expect(ended(yield* runToEnd(provider, input(home)))).toMatchObject({ type: "turn_completed" })
      }).pipe(Effect.scoped),
    ),
  )

  it.live("drops a pending approval when the CLI crashes while it waits", () =>
    withClis((lifeline) =>
      Effect.gen(function* () {
        const { home } = fakeHome({ lifeline })
        const provider = yield* harness
        const turn = yield* startTurn(provider, input(home, { prompt: "approve then crash" }))
        const { request } = yield* turn.until(
          (event): event is Extract<AgentEvent, { type: "approval_requested" }> => event.type === "approval_requested",
        )
        yield* Fiber.join(turn.fiber)
        expect(ended(turn.events)).toMatchObject({ type: "turn_failed" })
        expect(yield* provider.respondApproval(request.id, "allow")).toBe(false)
      }).pipe(Effect.scoped),
    ),
  )

  it.live("says the session is gone when the CLI cannot resume it", () =>
    withClis((lifeline) =>
      Effect.gen(function* () {
        const { home } = fakeHome({ lifeline })
        const provider = yield* harness
        const events = yield* runToEnd(provider, input(home, { resumeSessionId: "gone" }))
        expect(ended(events)).toStrictEqual({
          type: "turn_failed",
          message:
            "No conversation found with session ID: gone\n\nYour next message starts a new Claude session that gets this thread's transcript, without tool output.",
          sessionLost: true,
        })
      }).pipe(Effect.scoped),
    ),
  )
})
