import { expect, layer } from "@effect/vitest"
import { vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { NodeServices } from "@effect/platform-node"
import { Context, Deferred, Effect, Fiber, Layer, Option, Stream } from "effect"
import type { AgentEvent, McpConnection, ProviderId } from "../../shared/agent.ts"
import type { PushEvent } from "../../shared/contract.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import type { AgentProvider } from "../agents/provider.ts"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import { AgentRunner, layer as runnerLayer } from "../services/AgentRunner.ts"
import { ThreadNaming } from "../services/ThreadNaming.ts"
import { Events } from "../services/Events.ts"
import * as Git from "../services/Git.ts"
import * as GitHub from "../services/GitHub.ts"
import * as Messages from "../services/Messages.ts"
import * as Projects from "../services/Projects.ts"
import * as PullRequests from "../services/PullRequests.ts"
import { Secrets, layer as secretsLayer } from "../services/Secrets.ts"
import * as Settings from "../services/Settings.ts"
import { Threads, layer as threadsLayer } from "../services/Threads.ts"
import * as Worktrees from "../services/Worktrees.ts"
import { McpCredentials, layer as credentialsLayer } from "./credentials.ts"
import { layer as serverLayer } from "./server.ts"

vi.mock("electron", () => ({ BrowserWindow: {}, safeStorage: { isEncryptionAvailable: () => false } }))

const pushes: Array<PushEvent> = []

/** Two threads that exist in the database the server checks credentials against. */
class Seeded extends Context.Service<Seeded, { readonly a: string; readonly b: string }>()("test/Seeded") {}

const seeded = Layer.effect(
  Seeded,
  Effect.gen(function* () {
    const a = (yield* seedThread({ rootPath: "/repo-a" })).threadId
    const b = (yield* seedThread({ rootPath: "/repo-b" })).threadId
    return { a, b }
  }),
)

/** A provider whose turn stays open until it is interrupted, so tools can be called during it. */
const fakeProvider = (id: ProviderId): AgentProvider => {
  const turns = new Map<string, Deferred.Deferred<void>>()
  return {
    id,
    listModels: Effect.succeed([]),
    listCommands: () => Effect.succeed([]),
    runTurn: ({ threadId }) =>
      Stream.unwrap(
        Effect.map(Deferred.make<void>(), (done) => {
          turns.set(threadId, done)
          return Stream.fromEffect(Deferred.await(done)).pipe(Stream.as({ type: "turn_completed" } as AgentEvent))
        }),
      ),
    steer: () => Effect.void,
    interrupt: (threadId) => {
      const done = turns.get(threadId)
      return done ? Effect.asVoid(Deferred.succeed(done, undefined)) : Effect.void
    },
    respondApproval: () => Effect.void,
    setAccessMode: () => Effect.void,
  }
}

const stubs = Layer.mergeAll(
  Layer.succeed(ThreadNaming, ThreadNaming.of({ nameFromPrompt: () => Effect.void })),
  Layer.succeed(ClaudeProvider, fakeProvider("claude")),
  Layer.succeed(CodexProvider, fakeProvider("codex")),
  Layer.succeed(Events, { publish: (event) => Effect.sync(() => void pushes.push(event)) }),
)

const core = Layer.mergeAll(
  threadsLayer.pipe(
    Layer.provideMerge(Worktrees.layer),
    Layer.provideMerge(Projects.layer),
    Layer.provide(Settings.layer),
  ),
  Messages.layer,
  secretsLayer,
  credentialsLayer,
)
const domain = Layer.mergeAll(core, PullRequests.layer.pipe(Layer.provide(core)))
const agents = runnerLayer.pipe(Layer.provideMerge(domain))
const testLayer = Layer.mergeAll(serverLayer.pipe(Layer.provide(agents)), agents, seeded).pipe(
  Layer.provide(Layer.mergeAll(stubs, Git.layer)),
  Layer.provideMerge(GitHub.layer),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(NodeServices.layer),
)

interface ToolResult {
  readonly text: string
  readonly isError: boolean
}

/** Calls one tool the way an agent does and returns its text. */
const callAs = ({ url, headers }: McpConnection, name: string, args: Record<string, unknown> = {}) =>
  Effect.tryPromise(async (): Promise<ToolResult> => {
    const client = new Client({ name: "test", version: "0" })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
    try {
      const result = await client.callTool({ name, arguments: args })
      const content = result.content as Array<{ type: string; text?: string }>
      return { text: content.map((part) => part.text ?? "").join(""), isError: result.isError === true }
    } finally {
      await client.close()
    }
  })

/** Passes only when the server turns the connection away. */
const rejects = (connection: McpConnection) => Effect.flip(callAs(connection, "list_thread_pull_requests"))

const withAuthorization = (connection: McpConnection, authorization: string) => ({
  ...connection,
  headers: { authorization },
})

/** Polls on the live clock until `check` returns a value. */
const until = <A>(check: Effect.Effect<Option.Option<A>>): Effect.Effect<A> =>
  Effect.flatMap(check, (found) =>
    Option.isSome(found) ? Effect.succeed(found.value) : Effect.andThen(Effect.sleep("20 millis"), until(check)),
  )

const pendingSecretRequest = (threadId: string) =>
  Effect.gen(function* () {
    const runner = yield* AgentRunner
    return yield* until(
      runner.transcript(threadId).pipe(
        Effect.map(({ secretRequests }) => Option.fromNullishOr(secretRequests[0])),
        Effect.orElseSucceed(() => Option.none()),
      ),
    )
  })

// The HTTP server runs on the live clock; the test services would freeze its timeouts.
layer(testLayer, { excludeTestServices: true })("mcp server credentials", (it) => {
  it.effect("a credential acts only as the thread it was issued for", () =>
    Effect.gen(function* () {
      const mcp = yield* McpCredentials
      const pullRequests = yield* PullRequests.PullRequests
      const { a, b } = yield* Seeded
      yield* pullRequests.link(a, "https://github.com/o/r/pull/1")
      yield* pullRequests.link(b, "https://github.com/o/r/pull/2")
      const listed = (threadId: string) =>
        Effect.flatMap(mcp.connectionFor(threadId), (connection) =>
          Effect.map(callAs(connection, "list_thread_pull_requests"), (result) => result.text),
        )
      expect(yield* listed(a)).toBe("- https://github.com/o/r/pull/1")
      expect(yield* listed(b)).toBe("- https://github.com/o/r/pull/2")
    }),
  )

  it.effect("changing the thread parameter does not change identity", () =>
    Effect.gen(function* () {
      const mcp = yield* McpCredentials
      const { a, b } = yield* Seeded
      const connection = yield* mcp.connectionFor(a)
      const forged = new URL(connection.url)
      forged.searchParams.set("thread", b)
      const result = yield* callAs({ ...connection, url: forged.toString() }, "list_thread_pull_requests").pipe(
        Effect.orElseSucceed((): ToolResult => ({ text: "", isError: true })),
      )
      expect(result.text).not.toContain("pull/2")
    }),
  )

  it.effect("a thread's secret does not authenticate another thread", () =>
    Effect.gen(function* () {
      const mcp = yield* McpCredentials
      const { a, b } = yield* Seeded
      const connection = yield* mcp.connectionFor(a)
      yield* mcp.connectionFor(b)
      const relabeled = connection.headers.authorization.replace(`${a}.`, `${b}.`)
      yield* rejects(withAuthorization(connection, relabeled))
    }),
  )

  it.effect("unknown credentials are rejected", () =>
    Effect.gen(function* () {
      const mcp = yield* McpCredentials
      const { a } = yield* Seeded
      const connection = yield* mcp.connectionFor(a)
      yield* rejects(withAuthorization(connection, `Bearer ${a}.not-the-secret`))
      yield* rejects(withAuthorization(connection, "Bearer no-such-thread.secret"))
      yield* rejects(withAuthorization(connection, ""))
    }),
  )

  it.effect("a thread that is not in the database gets no access", () =>
    Effect.gen(function* () {
      const mcp = yield* McpCredentials
      yield* rejects(yield* mcp.connectionFor("thread-gone"))
    }),
  )
})

layer(testLayer, { excludeTestServices: true })("request_secret", (it) => {
  const VALUE = "sk-live-never-in-the-transcript"

  it.effect("stores what the user enters and returns only the name", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const secrets = yield* Secrets
      const mcp = yield* McpCredentials
      const { a } = yield* Seeded
      pushes.length = 0
      yield* runner.send(a, "hi", [])
      const call = yield* Effect.forkChild(
        callAs(yield* mcp.connectionFor(a), "request_secret", { name: "demo.token", description: "Demo API token" }),
      )
      const request = yield* pendingSecretRequest(a)
      expect(request).toMatchObject({ threadId: a, name: "demo.token", description: "Demo API token" })
      expect(yield* runner.transcript(a).pipe(Effect.map((t) => t.secretRequests))).toHaveLength(1)

      yield* runner.respondSecret(request.id, VALUE)
      const result = yield* Fiber.join(call)
      expect(result.isError).toBe(false)
      expect(result.text).toContain('Stored secret "demo.token"')
      expect(result.text).not.toContain(VALUE)
      expect(yield* secrets.get("demo.token")).toStrictEqual(Option.some(VALUE))

      expect(yield* runner.transcript(a).pipe(Effect.map((t) => t.secretRequests))).toHaveLength(0)
      const transcript = yield* runner.transcript(a)
      expect(JSON.stringify([pushes, transcript])).not.toContain(VALUE)
      expect(pushes.map((push) => (push.type === "thread.event" ? push.event.type : push.type))).toEqual(
        expect.arrayContaining(["secret_requested", "secret_resolved"]),
      )
      yield* runner.interrupt(a)
    }),
  )

  it.effect("a declined request is an error result and stores nothing", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const secrets = yield* Secrets
      const mcp = yield* McpCredentials
      const { a } = yield* Seeded
      yield* runner.send(a, "hi", [])
      const call = yield* Effect.forkChild(
        callAs(yield* mcp.connectionFor(a), "request_secret", { name: "declined.token", description: "x" }),
      )
      const request = yield* pendingSecretRequest(a)
      yield* runner.respondSecret(request.id, null)
      const result = yield* Fiber.join(call)
      expect(result.isError).toBe(true)
      expect(result.text).toContain("declined")
      expect(yield* secrets.has("declined.token")).toBe(false)
      yield* runner.interrupt(a)
    }),
  )

  it.effect("fails when the turn ends before the user answers", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const mcp = yield* McpCredentials
      const { a } = yield* Seeded
      yield* runner.send(a, "hi", [])
      const call = yield* Effect.forkChild(
        callAs(yield* mcp.connectionFor(a), "request_secret", { name: "late.token", description: "x" }),
      )
      yield* pendingSecretRequest(a)
      yield* runner.interrupt(a)
      const result = yield* Fiber.join(call)
      expect(result.isError).toBe(true)
      expect(result.text).toContain("turn ended")
    }),
  )

  it.effect("fails at once when no turn is running", () =>
    Effect.gen(function* () {
      const mcp = yield* McpCredentials
      const { b } = yield* Seeded
      const result = yield* callAs(yield* mcp.connectionFor(b), "request_secret", { name: "idle", description: "x" })
      expect(result.isError).toBe(true)
      expect(result.text).toContain("No turn is running")
    }),
  )
})

layer(testLayer, { excludeTestServices: true })("create_thread", (it) => {
  it.effect("starts a thread in the caller's project with the caller's provider and model", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const threads = yield* Threads
      const mcp = yield* McpCredentials
      const { a } = yield* Seeded
      pushes.length = 0
      const caller = yield* threads.get(a)
      const result = yield* callAs(yield* mcp.connectionFor(a), "create_thread", {
        title: "Side quest",
        prompt: "Look into the flaky test",
      })
      expect(result.isError).toBe(false)
      const id = /Created thread (\S+)/.exec(result.text)?.[1]
      if (id === undefined) throw new Error(`no thread id in ${result.text}`)

      const child = yield* threads.get(id)
      expect(child).toMatchObject({
        projectId: caller.projectId,
        title: "Side quest",
        provider: caller.provider,
        model: caller.model,
        status: "running",
        createdBy: `thread:${a}`,
      })
      const announced = pushes.find((push) => push.type === "thread.updated" && push.thread.id === id)
      expect(announced).toBeDefined()
      const transcript = yield* runner.transcript(id)
      expect(transcript.messages[0]).toMatchObject({
        role: "user",
        parts: [{ type: "text", text: "Look into the flaky test" }],
      })
      yield* runner.interrupt(id)
    }),
  )

  it.effect("another provider needs an explicit model", () =>
    Effect.gen(function* () {
      const mcp = yield* McpCredentials
      const { a } = yield* Seeded
      const result = yield* callAs(yield* mcp.connectionFor(a), "create_thread", {
        title: "t",
        prompt: "p",
        provider: "codex",
      })
      expect(result.isError).toBe(true)
      expect(result.text).toContain("model")
    }),
  )
})
