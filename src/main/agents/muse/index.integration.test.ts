import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, PubSub, Stream } from "effect"
import type { AgentEvent, RunTurnInput } from "../../../shared/agent.ts"
import type { AccessMode } from "../../../shared/domain.ts"
import { findBinary } from "../binary.ts"
import { AGENT_INSTRUCTIONS } from "../instructions.ts"
import { FAKE_MODEL_ID, type FakeEndpoint, startFakeEndpoint, startFakeMcpServer } from "./fakeEndpoint.ts"
import { MuseProvider } from "./index.ts"

/**
 * The muse launcher, found before HOME moves. A version manager's shim, such as mise's, reads its own config from
 * HOME and stops resolving once the test points HOME at the fake.
 */
const findMuse = async (): Promise<string | undefined> => {
  const found = await findBinary("muse")
  if (found === undefined) return undefined
  if (basename(realpathSync(found)) !== "mise") return found
  return execFileSync("mise", ["which", "muse"], { encoding: "utf8" }).trim()
}
const muse = await findMuse()

const REPLY = "Hello from the fake endpoint."

let root = ""
let endpoint: FakeEndpoint
let mcp: Awaited<ReturnType<typeof startFakeMcpServer>> | undefined

let turns = 0

/** Each turn gets its own workspace and a prompt marker the fake endpoint routes by. */
const input = (accessMode: AccessMode, marker: string): RunTurnInput => {
  const cwd = join(root, `ws-${marker}`)
  mkdirSync(cwd)
  return {
    threadId: `thread-${marker}`,
    prompt: `Please help. ${marker}`,
    attachments: [],
    cwd,
    model: FAKE_MODEL_ID,
    effort: null,
    fastMode: false,
    accessMode,
    resumeSessionId: null,
    home: null,
    mcpServer: { url: mcp!.url, headers: { authorization: "Bearer test" } },
    instructions: AGENT_INSTRUCTIONS,
  }
}

const writeProbeSkill = (cwd: string) => {
  const skillDir = join(cwd, ".agents", "skills", "probe-echo")
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: probe-echo",
      "description: Echo the probe marker word back to the user.",
      'argument-hint: "[word]"',
      "---",
      "",
      "PROBE-SKILL-BODY: reply with the word the user gave.",
      "",
    ].join("\n"),
  )
}

const startTurn = (accessMode: AccessMode, setup: (marker: string, input: RunTurnInput) => void = () => {}) =>
  Effect.gen(function* () {
    const provider = yield* MuseProvider
    turns += 1
    const marker = `kk-muse-turn-${turns}-${Date.now()}`
    const turnInput = input(accessMode, marker)
    setup(marker, turnInput)
    const events: Array<AgentEvent> = []
    const arrived = yield* PubSub.unbounded<AgentEvent>()
    const fiber = yield* provider.runTurn(turnInput).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => events.push(event)).pipe(Effect.andThen(PubSub.publish(arrived, event))),
      ),
      Effect.forkChild,
    )
    return { fiber, events, arrived, threadId: turnInput.threadId }
  })

type Turn = Effect.Success<ReturnType<typeof startTurn>>

/** Resolves with the first event matching `predicate`; subscribing first means none is missed. */
const untilEvent = <E extends AgentEvent>(turn: Turn, predicate: (event: AgentEvent) => event is E) =>
  Effect.gen(function* () {
    const updates = yield* PubSub.subscribe(turn.arrived)
    const seen = turn.events.find(predicate)
    if (seen !== undefined) return seen
    while (true) {
      const event = yield* PubSub.take(updates)
      if (predicate(event)) return event
    }
  }).pipe(Effect.scoped)

const ofType =
  <T extends AgentEvent["type"]>(type: T) =>
  (event: AgentEvent): event is Extract<AgentEvent, { type: T }> =>
    event.type === type

const eventsOf = <T extends AgentEvent["type"]>(turn: Turn, type: T) => turn.events.filter(ofType(type))

/** A fresh `muse serve` per test, shut down with the test scope. */
const withProvider = <A, E>(effect: Effect.Effect<A, E, MuseProvider>) =>
  effect.pipe(Effect.provide(MuseProvider.layer))

const TURN_TIMEOUT = 60_000

const twoStages = (marker: string) =>
  endpoint.script({
    when: marker,
    name: "bash",
    arguments: { command: "echo one && echo two", description: "Print two lines" },
  })

describe.skipIf(muse === undefined)("Muse Code against the real binary", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "kk-muse-"))
    endpoint = await startFakeEndpoint(root, REPLY)
    mcp = await startFakeMcpServer()
    const bin = join(root, "bin")
    mkdirSync(bin)
    symlinkSync(muse!, join(bin, "muse"))
    process.env.PATH = `${bin}:${process.env.PATH}`
    process.env.HOME = endpoint.home
    process.env.XDG_CONFIG_HOME = join(endpoint.home, ".config")
    process.env.XDG_DATA_HOME = join(endpoint.home, ".local", "share")
    process.env.MUSE_NO_AUTO_UPDATE = "1"
    // On macOS Muse moves a stored key into the login keychain, which the fake HOME lacks, so the OS prompts.
    process.env.TBH_CREDENTIAL_BACKEND = "file"
  })

  afterAll(async () => {
    await endpoint?.close()
    await mcp?.close()
    if (root !== "") rmSync(root, { recursive: true, force: true })
  })

  it.live(
    "lists the endpoint's model and reads the stored key as an API key",
    () =>
      withProvider(
        Effect.gen(function* () {
          const provider = yield* MuseProvider
          expect(yield* provider.listModels).toStrictEqual([
            expect.objectContaining({ id: FAKE_MODEL_ID, label: "Fake Model", provider: "muse" }),
          ])
          expect(yield* provider.account(null)).toStrictEqual({ type: "apiKey" })
        }),
      ),
    TURN_TIMEOUT,
  )

  it.live(
    "streams a text reply and completes with usage",
    () =>
      withProvider(
        Effect.gen(function* () {
          const turn = yield* startTurn("supervised")
          yield* Fiber.join(turn.fiber)
          expect(turn.events[0]).toStrictEqual({ type: "session_bound", providerSessionId: expect.any(String) })
          expect(
            eventsOf(turn, "text_delta")
              .map((event) => event.text)
              .join(""),
          ).toBe(REPLY)
          expect(turn.events.at(-1)).toStrictEqual({
            type: "turn_completed",
            usage: expect.objectContaining({ inputTokens: expect.any(Number), outputTokens: expect.any(Number) }),
          })
        }),
      ),
    TURN_TIMEOUT,
  )

  it.live(
    "asks once for a two-stage command and runs both stages when allowed",
    () =>
      withProvider(
        Effect.gen(function* () {
          const provider = yield* MuseProvider
          const turn = yield* startTurn("supervised", twoStages)
          const { request } = yield* untilEvent(turn, ofType("approval_requested"))
          expect(request).toMatchObject({ kind: "command", detail: "echo one && echo two", title: "Print two lines" })
          yield* provider.respondApproval(request.id, "allow")
          yield* Fiber.join(turn.fiber)

          expect(eventsOf(turn, "approval_requested")).toHaveLength(1)
          expect(eventsOf(turn, "approval_resolved")).toStrictEqual([
            { type: "approval_resolved", requestId: request.id },
          ])
          expect(eventsOf(turn, "tool_call_started")).toMatchObject([
            { name: "Bash", input: { command: "echo one && echo two" } },
          ])
          expect(eventsOf(turn, "tool_call_finished")).toMatchObject([{ output: "one\ntwo\n", isError: false }])
          expect(turn.events.at(-1)?.type).toBe("turn_completed")
        }),
      ),
    TURN_TIMEOUT,
  )

  it.live(
    "runs a command outside the sandbox under full access without asking",
    () =>
      withProvider(
        Effect.gen(function* () {
          const turn = yield* startTurn("full", (marker) =>
            endpoint.script({
              when: marker,
              name: "bash",
              arguments: {
                command: "echo escalated",
                description: "Print outside the sandbox",
                sandbox_permissions: "require_escalated",
              },
            }),
          )
          yield* Fiber.join(turn.fiber)

          expect(eventsOf(turn, "approval_requested")).toStrictEqual([])
          expect(eventsOf(turn, "tool_call_finished")).toMatchObject([{ output: "escalated\n", isError: false }])
        }),
      ),
    TURN_TIMEOUT,
  )

  it.live(
    "fails the command and still completes the turn when denied",
    () =>
      withProvider(
        Effect.gen(function* () {
          const provider = yield* MuseProvider
          const turn = yield* startTurn("supervised", twoStages)
          const { request } = yield* untilEvent(turn, ofType("approval_requested"))
          yield* provider.respondApproval(request.id, "deny")
          yield* Fiber.join(turn.fiber)

          expect(eventsOf(turn, "approval_requested")).toHaveLength(1)
          expect(eventsOf(turn, "approval_resolved")).toStrictEqual([
            { type: "approval_resolved", requestId: request.id },
          ])
          expect(eventsOf(turn, "tool_call_finished")).toMatchObject([{ isError: true }])
          expect(turn.events.at(-1)?.type).toBe("turn_completed")
        }),
      ),
    TURN_TIMEOUT,
  )

  it.live(
    "asks the user a question and sends the picked option back",
    () =>
      withProvider(
        Effect.gen(function* () {
          const provider = yield* MuseProvider
          const turn = yield* startTurn("supervised", (marker) =>
            endpoint.script({
              when: marker,
              name: "request_user_input",
              arguments: {
                questions: [
                  {
                    id: "color",
                    header: "Color",
                    question: "Which color?",
                    options: [
                      { label: "Blue", description: "Cool" },
                      { label: "Red", description: "Warm" },
                    ],
                  },
                ],
              },
            }),
          )
          const { request } = yield* untilEvent(turn, ofType("question_requested"))
          expect(request.questions).toStrictEqual([
            {
              id: "color",
              header: "Color",
              question: "Which color?",
              options: [
                { label: "Blue", description: "Cool" },
                { label: "Red", description: "Warm" },
              ],
              multiSelect: false,
              allowsText: true,
              secret: false,
            },
          ])
          yield* provider.respondQuestion(request.id, { color: ["Red"] })
          yield* Fiber.join(turn.fiber)

          expect(eventsOf(turn, "question_resolved")).toStrictEqual([
            { type: "question_resolved", requestId: request.id },
          ])
          expect(eventsOf(turn, "tool_call_finished")).toMatchObject([{ isError: false }])
          expect(turn.events.at(-1)?.type).toBe("turn_completed")
        }),
      ),
    TURN_TIMEOUT,
  )

  it.live(
    "stops a turn whose reply is still streaming",
    () =>
      withProvider(
        Effect.gen(function* () {
          const provider = yield* MuseProvider
          let marker = ""
          const turn = yield* startTurn("supervised", (held) => {
            marker = held
            endpoint.hold(held)
          })
          // Muse shows none of a reply until its completion ends, so the held request is the signal.
          yield* Effect.promise(() => endpoint.requested(marker))
          yield* provider.interrupt(turn.threadId)
          yield* Fiber.join(turn.fiber)
          expect(turn.events.at(-1)).toStrictEqual({ type: "turn_failed", message: "Turn interrupted" })
        }),
      ),
    TURN_TIMEOUT,
  )

  it.live(
    "reads a session's tokens from its log and its reminder agents' logs",
    () =>
      withProvider(
        Effect.gen(function* () {
          const provider = yield* MuseProvider
          const turn = yield* startTurn("supervised")
          yield* Fiber.join(turn.fiber)
          const [bound] = eventsOf(turn, "session_bound")
          const usage = yield* provider.usage(bound!.providerSessionId, null)
          expect(usage?.models).toStrictEqual([
            {
              model: FAKE_MODEL_ID,
              inputTokens: expect.any(Number),
              cacheWriteTokens: 0,
              cacheReadTokens: 0,
              outputTokens: expect.any(Number),
            },
          ])
          expect(usage!.models[0]!.outputTokens).toBeGreaterThan(0)
          expect(usage!.transcripts).toBeGreaterThan(1)
        }),
      ),
    TURN_TIMEOUT,
  )

  it.live(
    "lists the workspace's skills for the composer and expands a typed skill invocation",
    () =>
      withProvider(
        Effect.gen(function* () {
          const provider = yield* MuseProvider
          const cwd = join(root, "ws-skills")
          writeProbeSkill(cwd)

          const commands = yield* provider.listCommands({ threadId: "thread-skills", cwd, home: null })
          expect(commands).toContainEqual({
            trigger: "/",
            name: "probe-echo",
            description: "Echo the probe marker word back to the user.",
            argumentHint: "[word]",
          })

          const events: Array<AgentEvent> = []
          yield* provider
            .runTurn({
              threadId: "thread-skills",
              prompt: "/probe-echo banana",
              instructions: AGENT_INSTRUCTIONS,
              attachments: [],
              cwd,
              model: FAKE_MODEL_ID,
              effort: null,
              fastMode: false,
              accessMode: "supervised",
              resumeSessionId: null,
              home: null,
              mcpServer: { url: mcp!.url, headers: { authorization: "Bearer [REDACTED]" } },
            })
            .pipe(Stream.runForEach((event) => Effect.sync(() => events.push(event))))
          // The host expands the skill, so its body reaches the model endpoint.
          yield* Effect.promise(() => endpoint.requested("PROBE-SKILL-BODY"))
          expect(events.at(-1)?.type).toBe("turn_completed")
        }),
      ),
    TURN_TIMEOUT,
  )

  it.live(
    "accepts a known slash skill as ordinary steering text with file attachments",
    () =>
      withProvider(
        Effect.gen(function* () {
          const provider = yield* MuseProvider
          let marker = ""
          let cwd = ""
          const turn = yield* startTurn("full", (held, turnInput) => {
            marker = held
            cwd = turnInput.cwd
            writeProbeSkill(cwd)
            endpoint.hold(held)
          })
          yield* Effect.promise(() => endpoint.requested(marker))
          const commands = yield* provider.listCommands({ threadId: turn.threadId, cwd, home: null })
          expect(commands.some((command) => command.name === "probe-echo")).toBe(true)
          const path = join(cwd, "attached.txt")
          writeFileSync(path, "hello")
          yield* provider.steer(turn.threadId, "/probe-echo steering-fruit", [
            { id: "steering-file", name: "attached.txt", path, mime: "text/plain", kind: "file", bytes: 5 },
          ])
          yield* provider.steer(turn.threadId, "ordinary follow-up", [])
          yield* provider.interrupt(turn.threadId)
          yield* Fiber.join(turn.fiber)
          expect(turn.events.at(-1)).toStrictEqual({ type: "turn_failed", message: "Turn interrupted" })
        }),
      ),
    TURN_TIMEOUT,
  )
})
