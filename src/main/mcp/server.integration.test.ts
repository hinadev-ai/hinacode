import { EventEmitter } from "node:events"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, layer } from "@effect/vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { NodeServices } from "@effect/platform-node"
import { Context, Deferred, type Duration, Effect, Fiber, Layer, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { AgentEvent, McpConnection, ProviderId, RunTurnInput } from "../../shared/agent.ts"
import type { PushEvent } from "../../shared/contract.ts"
import { defaultSettings } from "../../shared/domain.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import type { AgentProvider } from "../agents/provider.ts"
import * as Db from "../db/client.ts"
import { Peers } from "../remote/peers.ts"
import { seedThread } from "../db/testing.ts"
import * as Attachments from "../services/Attachments.ts"
import * as AgentAccounts from "../services/AgentAccounts.ts"
import { AgentRunner, layer as runnerLayer } from "../services/AgentRunner.ts"
import { ThreadNaming } from "../services/ThreadNaming.ts"
import { Events } from "../services/Events.ts"
import * as Git from "../services/Git.ts"
import * as GitHub from "../services/GitHub.ts"
import * as Messages from "../services/Messages.ts"
import * as Projects from "../services/Projects.ts"
import * as PullRequests from "../services/PullRequests.ts"
import { layer as linearLayer } from "../services/Linear.ts"
import { noKeyring, Secrets, layer as secretsLayer } from "../services/Secrets.ts"
import * as Settings from "../services/Settings.ts"
import * as Terminals from "../services/Terminals.ts"
import { decodeTar, encodeTar } from "../services/tinyVm/tar.ts"
import { FAKE_PNG, FakeSbxServer, fakeSbxLayer } from "../services/tinyVm/testing.ts"
import { HAND_BACK_GRACE, TinyVm, layer as tinyVmLayer } from "../services/tinyVm/TinyVm.ts"
import { Threads, layer as threadsLayer } from "../services/Threads.ts"
import * as Worktrees from "../services/Worktrees.ts"
import { McpCredentials, layer as credentialsLayer } from "./credentials.ts"
import { layer as serverLayer } from "./server.ts"
import { SETTLE_MS } from "./tools/tinyVm.ts"

const pushes: Array<PushEvent> = []
const turnInputs: Array<RunTurnInput> = []

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
    account: () => Effect.succeed({ type: "signedOut" }),
    planLimits: () => Effect.succeed(null),
    usage: () => Effect.succeed(null),
    listCommands: () => Effect.succeed([]),
    runTurn: (input) =>
      Stream.unwrap(
        Effect.map(Deferred.make<void>(), (done) => {
          turnInputs.push(input)
          turns.set(input.threadId, done)
          return Stream.fromEffect(Deferred.await(done)).pipe(Stream.as({ type: "turn_completed" } as AgentEvent))
        }),
      ),
    steer: () => Effect.void,
    interrupt: (threadId) => {
      const done = turns.get(threadId)
      return done ? Effect.asVoid(Deferred.succeed(done, undefined)) : Effect.void
    },
    respondApproval: () => Effect.void,
    respondQuestion: () => Effect.void,
    setAccessMode: () => Effect.void,
  }
}

const stubs = Layer.mergeAll(
  Layer.succeed(ThreadNaming, ThreadNaming.of({ nameFromPrompt: () => Effect.void })),
  Layer.succeed(ClaudeProvider, fakeProvider("claude")),
  Layer.succeed(CodexProvider, fakeProvider("codex")),
  Layer.succeed(MuseProvider, fakeProvider("muse")),
  Layer.succeed(Events, { publish: (event) => Effect.sync(() => void pushes.push(event)) }),
  Layer.succeed(
    Peers,
    Peers.of({
      ask: () => Effect.fail({ message: "This machine has no other machines." }),
      join: () => ({ answer: () => {}, leave: () => {} }),
    }),
  ),
)

const core = Layer.mergeAll(
  threadsLayer.pipe(
    Layer.provide(Terminals.layer),
    Layer.provideMerge(Worktrees.layer),
    Layer.provideMerge(Projects.layer),
    Layer.provideMerge(AgentAccounts.layer),
    Layer.provideMerge(Settings.layer),
  ),
  Messages.layer,
  Attachments.layer(join(mkdtempSync(join(tmpdir(), "kk-mcp-")), "attachments")),
  secretsLayer.pipe(Layer.provide(noKeyring)),
  credentialsLayer,
)
const vmProfileDir = mkdtempSync(join(tmpdir(), "kk-vm-profile-"))
const tinyVm = Layer.unwrap(
  Effect.gen(function* () {
    const fake = yield* FakeSbxServer
    return tinyVmLayer({ configPath: fake.configPath, env: {} }, vmProfileDir)
  }),
).pipe(Layer.provideMerge(fakeSbxLayer))
const domain = Layer.mergeAll(
  core,
  PullRequests.layer.pipe(Layer.provide(core)),
  tinyVm.pipe(Layer.provide(core)),
  linearLayer.pipe(Layer.provide(core)),
)
const agents = runnerLayer.pipe(Layer.provideMerge(domain))
const testLayer = Layer.mergeAll(serverLayer.pipe(Layer.provide(Layer.mergeAll(agents, stubs))), agents, seeded).pipe(
  Layer.provide(Layer.mergeAll(stubs, Git.layer)),
  Layer.provideMerge(GitHub.layer.pipe(Layer.provide(stubs))),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(NodeServices.layer),
)

interface ToolResult {
  readonly text: string
  readonly isError: boolean
  /** Base64 data of each image block. */
  readonly images: ReadonlyArray<string>
}

const withClient = <A>({ url, headers }: McpConnection, use: (client: Client) => Promise<A>) =>
  Effect.tryPromise(async () => {
    const client = new Client({ name: "test", version: "0" })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
    try {
      return await use(client)
    } finally {
      await client.close()
    }
  })

/** Calls one tool the way an agent does and returns its text. */
const callAs = (connection: McpConnection, name: string, args: Record<string, unknown> = {}) =>
  withClient(connection, async (client): Promise<ToolResult> => {
    const result = await client.callTool({ name, arguments: args })
    const content = result.content as Array<{ type: string; text?: string; data?: string }>
    return {
      text: content.map((part) => part.text ?? "").join(""),
      isError: result.isError === true,
      images: content.flatMap((part) => (part.type === "image" && part.data !== undefined ? [part.data] : [])),
    }
  })

const toolNames = (connection: McpConnection) =>
  withClient(connection, async (client) => (await client.listTools()).tools.map((listed) => listed.name))

/** Passes only when the server turns the connection away. */
const rejects = (connection: McpConnection) => Effect.flip(callAs(connection, "list_thread_pull_requests"))

const withAuthorization = (connection: McpConnection, authorization: string) => ({
  ...connection,
  headers: { authorization },
})

/** Polls on the live clock until `check` returns a value. */
const until = <A>(check: Effect.Effect<Option.Option<A>>): Effect.Effect<A> =>
  Effect.flatMap(check, (found) =>
    Option.isSome(found)
      ? Effect.succeed(found.value)
      : Effect.andThen(TestClock.withLive(Effect.sleep("20 millis")), until(check)),
  )

/** Moves the test clock on by `step` until `check` passes, since the fiber that sleeps may not have started yet. */
const advanceUntil = <A>(step: Duration.Input, check: Effect.Effect<Option.Option<A>>) =>
  until(Effect.andThen(TestClock.adjust(step), check))

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

layer(testLayer)("mcp server credentials", (it) => {
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

  it.effect("watch_pull_request watches only the calling thread's pull request", () =>
    Effect.gen(function* () {
      const mcp = yield* McpCredentials
      const pullRequests = yield* PullRequests.PullRequests
      const { a, b } = yield* Seeded
      const connection = yield* mcp.connectionFor(a)
      const url = "https://github.com/o/r/pull/9"

      const watched = yield* callAs(connection, "watch_pull_request", { url, events: ["checksFailed"] })
      expect(watched.isError).toBe(false)
      expect(watched.text).toContain("Watching https://github.com/o/r/pull/9 for checksFailed")

      const listed = yield* callAs(connection, "list_thread_pull_requests")
      expect(listed.text).toContain("watching for checksFailed")
      expect((yield* pullRequests.list(b)).some((link) => link.url === url)).toBe(false)

      const stopped = yield* callAs(connection, "unwatch_pull_request", { url })
      expect(stopped.isError).toBe(false)
      const links = yield* pullRequests.list(a)
      expect(links.find((link) => link.url === url)?.watch).toBeNull()
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
        Effect.orElseSucceed((): ToolResult => ({ text: "", isError: true, images: [] })),
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

layer(testLayer)("request_secret", (it) => {
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

layer(testLayer)("create_thread", (it) => {
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

const childOf = (callerId: string, title: string) =>
  Effect.gen(function* () {
    const threads = yield* Threads
    const caller = yield* threads.get(callerId)
    return (yield* threads.create({ projectId: caller.projectId, title, provider: "claude", model: "m" })).id
  })

const callFrom = (threadId: string, name: string, args: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const mcp = yield* McpCredentials
    return yield* callAs(yield* mcp.connectionFor(threadId), name, args)
  })

layer(testLayer)("thread controls", (it) => {
  it.effect("list_threads shows this project's threads and marks the caller", () =>
    Effect.gen(function* () {
      const { a, b } = yield* Seeded
      const child = yield* childOf(a, "Listed child")
      const result = yield* callFrom(a, "list_threads")
      const listed = JSON.parse(result.text) as Array<{ id: string; self?: boolean }>
      expect(listed.map((thread) => thread.id).toSorted()).toEqual([a, child].toSorted())
      expect(listed.find((thread) => thread.id === a)?.self).toBe(true)
      expect(listed.find((thread) => thread.id === child)).toMatchObject({ title: "Listed child", status: "idle" })
      expect(listed.some((thread) => thread.id === b)).toBe(false)
    }),
  )

  it.effect("read_thread returns the status, the metadata and the latest messages", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const pullRequests = yield* PullRequests.PullRequests
      const { a } = yield* Seeded
      const child = yield* childOf(a, "Read child")
      yield* pullRequests.link(child, "https://github.com/o/r/pull/7")
      yield* runner.send(child, "Look into the flaky test", [])
      const result = yield* callFrom(a, "read_thread", { threadId: child })
      expect(result.isError).toBe(false)
      expect(result.text).toMatch(
        new RegExp(
          [
            "^<metadata>",
            `thread_id: ${child}`,
            "title: Read child",
            "status: running",
            "provider: claude",
            "model: m",
            "effort: default",
            "created_by: user",
            "created_at: \\S+",
            "updated_at: \\S+",
            "pull_requests:",
            "- https://github.com/o/r/pull/7",
            "</metadata>",
            "<environment>",
            "workspace: project root",
            "</environment>",
          ].join("\n"),
        ),
      )
      expect(result.text).toMatch(/## user \(\S+\)\nLook into the flaky test/)
      yield* runner.interrupt(child)
    }),
  )

  it.effect("send_to_thread starts a turn, then steers it, and stop_thread interrupts it", () =>
    Effect.gen(function* () {
      const threads = yield* Threads
      const { a } = yield* Seeded
      const child = yield* childOf(a, "Driven child")
      const started = yield* callFrom(a, "send_to_thread", { threadId: child, prompt: "Begin" })
      expect(started.text).toBe(`Started a new turn on thread ${child}.`)
      expect((yield* threads.get(child)).status).toBe("running")

      const steered = yield* callFrom(a, "send_to_thread", { threadId: child, prompt: "Also this" })
      expect(steered.text).toBe(`Steered the running turn of thread ${child}.`)

      const stopped = yield* callFrom(a, "stop_thread", { threadId: child })
      expect(stopped.text).toBe(`Interrupted thread ${child}.`)
      yield* until(
        threads.get(child).pipe(
          Effect.map((thread) => Option.liftPredicate(thread, (t) => t.status === "idle")),
          Effect.orDie,
        ),
      )
    }),
  )

  it.effect("send_to_thread sets the model and effort of a thread that has not started", () =>
    Effect.gen(function* () {
      const threads = yield* Threads
      const { a } = yield* Seeded
      const child = yield* childOf(a, "Configured child")
      const sent = yield* callFrom(a, "send_to_thread", {
        threadId: child,
        prompt: "Begin",
        model: "m2",
        effort: "low",
      })
      expect(sent.isError).toBe(false)
      expect(yield* threads.get(child)).toMatchObject({ model: "m2", effort: "low" })
      yield* (yield* AgentRunner).interrupt(child)
    }),
  )

  it.effect("send_to_thread only changes the effort of a thread that has started", () =>
    Effect.gen(function* () {
      const threads = yield* Threads
      const { a } = yield* Seeded
      const child = yield* childOf(a, "Started child")
      yield* threads.update({ id: child, providerSessionId: "session-1" })
      const refused = yield* callFrom(a, "send_to_thread", { threadId: child, prompt: "x", model: "m2" })
      expect(refused).toStrictEqual({
        text: `Thread ${child} has started, so its model stays m. Pass only \`effort\`.`,
        isError: true,
        images: [],
      })
      const sent = yield* callFrom(a, "send_to_thread", { threadId: child, prompt: "Again", effort: "max" })
      expect(sent.isError).toBe(false)
      expect(yield* threads.get(child)).toMatchObject({ model: "m", effort: "max" })
      yield* (yield* AgentRunner).interrupt(child)
    }),
  )

  it.effect("create_thread sets the effort", () =>
    Effect.gen(function* () {
      const threads = yield* Threads
      const { a } = yield* Seeded
      const created = yield* callFrom(a, "create_thread", { title: "Effortful", prompt: "Go", effort: "high" })
      const id = /Created thread (\S+) /.exec(created.text)![1]!
      expect(yield* threads.get(id)).toMatchObject({ effort: "high" })
      yield* (yield* AgentRunner).interrupt(id)
    }),
  )

  it.effect("a thread of another project or a deleted one is out of reach", () =>
    Effect.gen(function* () {
      const { a, b } = yield* Seeded
      for (const name of ["read_thread", "send_to_thread", "stop_thread"]) {
        const result = yield* callFrom(a, name, { threadId: b, prompt: "x" })
        expect(result).toStrictEqual({ text: `Thread ${b} is not in this project.`, isError: true, images: [] })
      }
      const gone = yield* callFrom(a, "read_thread", { threadId: "thread-gone" })
      expect(gone).toStrictEqual({ text: "Thread thread-gone no longer exists.", isError: true, images: [] })
    }),
  )

  it.effect("send_to_thread and stop_thread refuse the caller itself", () =>
    Effect.gen(function* () {
      const { a } = yield* Seeded
      for (const name of ["send_to_thread", "stop_thread"]) {
        const result = yield* callFrom(a, name, { threadId: a, prompt: "x" })
        expect(result.isError).toBe(true)
        expect(result.text).toContain("own turn")
      }
    }),
  )
})

const setTinyVm = (on: boolean, tinyVmTemplate = "default", tinyVmProfile = false) =>
  Effect.gen(function* () {
    const settings = yield* Settings.Settings
    const vm = yield* TinyVm
    yield* settings.set({
      experimental: { ...defaultSettings.experimental, tinyVm: on, tinyVmTemplate, tinyVmProfile },
    })
    yield* until(Effect.sync(() => (vm.enabled() === on ? Option.some(true) : Option.none())))
  })

const VM_TOOLS = [
  "vm_screenshot",
  "vm_click",
  "vm_move",
  "vm_drag",
  "vm_scroll",
  "vm_type",
  "vm_key",
  "vm_exec",
  "vm_pull_file",
]

layer(testLayer)("tiny vm tools while the toggle is off", (it) => {
  it.effect("are not listed and cannot be called", () =>
    Effect.gen(function* () {
      const mcp = yield* McpCredentials
      const fake = yield* FakeSbxServer
      const { a } = yield* Seeded
      const connection = yield* mcp.connectionFor(a)
      const names = yield* toolNames(connection)
      expect(names).toContain("link_pull_request")
      expect(names.filter((name) => VM_TOOLS.includes(name))).toStrictEqual([])
      const refused = yield* callAs(connection, "vm_screenshot").pipe(
        Effect.map((result) => result.isError),
        Effect.orElseSucceed(() => true),
      )
      expect(refused).toBe(true)
      expect(fake.created()).toBe(0)
    }),
  )
})

layer(testLayer)("tiny vm tools", (it) => {
  it.effect("are listed once the toggle is on", () =>
    Effect.gen(function* () {
      const mcp = yield* McpCredentials
      const { a } = yield* Seeded
      yield* setTinyVm(true)
      expect(yield* toolNames(yield* mcp.connectionFor(a))).toEqual(expect.arrayContaining(VM_TOOLS))
    }),
  )

  it.effect("vm_screenshot returns the screen as an image, and racing calls share one sandbox", () =>
    Effect.gen(function* () {
      const mcp = yield* McpCredentials
      const vm = yield* TinyVm
      const fake = yield* FakeSbxServer
      const { a } = yield* Seeded
      yield* setTinyVm(true)
      yield* vm.stop(a)
      const before = fake.created()
      const connection = yield* mcp.connectionFor(a)
      const [first, second] = yield* Effect.all(
        [callAs(connection, "vm_screenshot"), callAs(connection, "vm_screenshot")],
        {
          concurrency: "unbounded",
        },
      )
      expect(first.isError).toBe(false)
      expect(first.text).toContain("1280×800")
      expect(first.images).toStrictEqual([FAKE_PNG.toString("base64")])
      expect(second.images).toStrictEqual([FAKE_PNG.toString("base64")])
      expect(fake.created() - before).toBe(1)
      expect(yield* vm.get(a)).toMatchObject({ status: "running", control: "agent" })
      expect(pushes).toContainEqual({ type: "vm.updated", threadId: a, vm: { status: "starting" } })
    }),
  )

  it.effect("vm_screenshot with save stores the PNG on the host and returns Markdown for it", () =>
    Effect.gen(function* () {
      const mcp = yield* McpCredentials
      const { a } = yield* Seeded
      yield* setTinyVm(true)
      const result = yield* callAs(yield* mcp.connectionFor(a), "vm_screenshot", { save: true })
      expect(result.isError).toBe(false)
      const path = /!\[[^\]]*\]\(<([^>]+)>\)/.exec(result.text)?.[1]
      expect(path).toMatch(new RegExp(`/attachments/${a}/.+\\.png$`))
      expect(yield* Effect.promise(() => readFile(path!))).toStrictEqual(FAKE_PNG)
      expect(result.images).toStrictEqual([FAKE_PNG.toString("base64")])
    }),
  )

  it.effect("vm_click presses at the point and shows the screen once it settles", () =>
    Effect.gen(function* () {
      const mcp = yield* McpCredentials
      const vm = yield* TinyVm
      const fake = yield* FakeSbxServer
      const { a } = yield* Seeded
      yield* setTinyVm(true)
      fake.inputs.length = 0
      const call = yield* Effect.forkChild(callAs(yield* mcp.connectionFor(a), "vm_click", { x: 640, y: 400 }))
      yield* until(Effect.sync(() => (fake.inputs.length === 3 ? Option.some(true) : Option.none())))
      yield* TestClock.withLive(Effect.sleep("50 millis"))
      expect(call.pollUnsafe()).toBeUndefined()

      yield* advanceUntil(
        SETTLE_MS,
        Effect.sync(() => Option.fromNullishOr(call.pollUnsafe())),
      )
      const result = yield* Fiber.join(call)
      expect(result.isError).toBe(false)
      expect(result.images).toHaveLength(1)
      const running = yield* vm.get(a)
      if (running.status !== "running") throw new Error(`VM is ${running.status}`)
      expect(fake.inputs).toStrictEqual(
        [0, 1, 0].map((mask) => ({ sandboxId: running.sandboxId, event: { type: "pointer", x: 640, y: 400, mask } })),
      )
    }),
  )

  it.effect("a coordinate off the screen is an error that names the limit", () =>
    Effect.gen(function* () {
      const mcp = yield* McpCredentials
      const { a } = yield* Seeded
      yield* setTinyVm(true)
      const result = yield* callAs(yield* mcp.connectionFor(a), "vm_click", { x: 5000, y: 10 })
      expect(result.isError).toBe(true)
      expect(result.text).toContain("x must be between 0 and 1279")
    }),
  )

  it.effect("vm_exec reports the exit code and output", () =>
    Effect.gen(function* () {
      const mcp = yield* McpCredentials
      const { a } = yield* Seeded
      yield* setTinyVm(true)
      const connection = yield* mcp.connectionFor(a)
      const result = yield* callAs(connection, "vm_exec", { command: "echo hi" })
      expect(result.text).toContain("Exit code 0")
      expect(result.text).toContain("echo hi")
      const background = yield* callAs(connection, "vm_exec", { command: "chromium", background: true })
      expect(background.text).toBe("Started in the background as pid 4242. Output goes to /tmp/sbx-4242.log.")
    }),
  )

  it.effect("a VM starts from the configured template, and the host names its templates", () =>
    Effect.gen(function* () {
      const vm = yield* TinyVm
      const fake = yield* FakeSbxServer
      const { a, b } = yield* Seeded
      yield* setTinyVm(true, "browser")
      yield* vm.stop(a)
      const before = fake.createdTemplates.length
      const started = yield* vm.start(a)
      expect(started).toMatchObject({ status: "running", template: "browser" })
      expect(fake.createdTemplates.slice(before)).toStrictEqual(["browser"])

      const overridden = yield* vm.start(b, "default")
      expect(overridden).toMatchObject({ status: "running", template: "default" })
      expect(fake.createdTemplates.at(-1)).toBe("default")

      const host = yield* vm.host
      expect(host).toMatchObject({ status: "connected" })
      if (host.status === "connected") {
        expect(host.templates).toStrictEqual([
          { name: "default", cpus: 2, memoryMiB: 8192 },
          { name: "browser", cpus: 2, memoryMiB: 2048 },
        ])
      }
      yield* vm.stop(b)
      yield* setTinyVm(true)
    }),
  )

  it.effect("the stored browser profile restores into a fresh VM and only its owner saves it back", () =>
    Effect.gen(function* () {
      const vm = yield* TinyVm
      const fake = yield* FakeSbxServer
      const { a, b } = yield* Seeded
      const storedPath = join(vmProfileDir, "chromium-profile.tgz")
      writeFileSync(storedPath, "profile-bytes-1")
      yield* setTinyVm(true, "default", true)
      yield* vm.stop(a)
      yield* vm.stop(b)
      const uploadsBefore = fake.uploads.length

      const started = yield* vm.start(a)
      expect(started).toMatchObject({ status: "running", profile: "owner" })
      const restore = fake.uploads.at(-1)!
      expect(fake.uploads.length).toBe(uploadsBefore + 1)
      expect(restore.path).toBe("/tmp")
      const wrapped = decodeTar(restore.bytes)[0]
      expect(wrapped?.type).toBe("file")
      if (wrapped?.type === "file") expect(new TextDecoder().decode(wrapped.data)).toBe("profile-bytes-1")
      expect(fake.execs.some((exec) => exec.script.includes("tar -xzf /tmp/hinacode-chromium-profile.tgz"))).toBe(true)

      const second = yield* vm.start(b)
      expect(second).toMatchObject({ status: "running", profile: "copy" })
      const refused = yield* Effect.flip(vm.saveProfile(b))
      expect(refused.message).toContain("Another thread")

      if (started.status !== "running") throw new Error(`VM is ${started.status}`)
      fake.seedFile(
        started.sandboxId,
        "/tmp/hinacode-chromium-profile.tgz",
        encodeTar([
          {
            type: "file",
            path: "hinacode-chromium-profile.tgz",
            data: new TextEncoder().encode("profile-bytes-2"),
            mode: 0o600,
            mtime: 1700000000,
          },
        ]),
      )
      yield* vm.saveProfile(a)
      expect(yield* Effect.promise(() => readFile(storedPath, "utf8"))).toBe("profile-bytes-2")

      yield* vm.stop(b)
      yield* vm.stop(a)
      yield* setTinyVm(true)
    }),
  )

  it.effect("dropped files land in ~/Downloads and the next tool result tells the agent once", () =>
    Effect.gen(function* () {
      const mcp = yield* McpCredentials
      const vm = yield* TinyVm
      const fake = yield* FakeSbxServer
      const { a } = yield* Seeded
      yield* setTinyVm(true)
      yield* vm.start(a)
      const dir = mkdtempSync(join(tmpdir(), "kk-drop-"))
      const folder = join(dir, "notes")
      mkdirSync(folder)
      writeFileSync(join(folder, "hello.txt"), "hello vm\n")
      const uploadsBefore = fake.uploads.length

      const landed = yield* vm.dropFiles(a, [folder])
      expect(landed).toStrictEqual(["~/Downloads/notes"])
      expect(fake.execs.some((exec) => exec.script.includes("mkdir -p ~/Downloads"))).toBe(true)
      expect(fake.uploads).toHaveLength(uploadsBefore + 1)
      const upload = fake.uploads.at(-1)!
      expect(upload.path).toBe("Downloads")
      const entries = decodeTar(upload.bytes)
      expect(entries.map((entry) => entry.path)).toStrictEqual(["notes", "notes/hello.txt"])
      const hello = entries[1]
      expect(hello?.type).toBe("file")
      if (hello?.type === "file") expect(new TextDecoder().decode(hello.data)).toBe("hello vm\n")

      const connection = yield* mcp.connectionFor(a)
      const first = yield* callAs(connection, "vm_exec", { command: "ls ~/Downloads" })
      expect(first.text).toContain("The user dropped files into the VM: ~/Downloads/notes")
      const second = yield* callAs(connection, "vm_exec", { command: "ls ~/Downloads" })
      expect(second.text).not.toContain("dropped files")
    }),
  )

  it.effect("vm_pull_file copies a VM folder into a new folder on this machine", () =>
    Effect.gen(function* () {
      const mcp = yield* McpCredentials
      const vm = yield* TinyVm
      const fake = yield* FakeSbxServer
      const { a } = yield* Seeded
      yield* setTinyVm(true)
      const started = yield* vm.start(a)
      if (started.status !== "running") throw new Error(`VM is ${started.status}`)
      fake.seedFile(
        started.sandboxId,
        "Downloads/report",
        encodeTar([
          { type: "dir", path: "report", mode: 0o755, mtime: 1700000000 },
          { type: "file", path: "report/q3.csv", data: new TextEncoder().encode("a,b\n"), mode: 0o755, mtime: 0 },
          { type: "symlink", path: "report/home", target: "/home/user", mode: 0o777, mtime: 0 },
        ]),
      )
      const connection = yield* mcp.connectionFor(a)

      const result = yield* callAs(connection, "vm_pull_file", { path: "~/Downloads/report" })
      expect(result.isError).toBe(false)
      const landed = /to (\S+) \(1 file, 0\.0 MB\)/.exec(result.text)?.[1]
      expect(landed).toMatch(new RegExp(`^${join(vmProfileDir, "pulled", a)}/[0-9a-f-]{36}/report$`))
      expect(yield* Effect.promise(() => readFile(join(landed!, "q3.csv"), "utf8"))).toBe("a,b\n")
      expect(result.text).toContain("Skipped symlinks: report/home")

      const again = yield* callAs(connection, "vm_pull_file", { path: "~/Downloads/report" })
      expect(again.text).not.toContain(landed!)
    }),
  )

  it.effect("vm_pull_file on a missing path says so and keeps the VM", () =>
    Effect.gen(function* () {
      const mcp = yield* McpCredentials
      const vm = yield* TinyVm
      const { a } = yield* Seeded
      yield* setTinyVm(true)
      const started = yield* vm.start(a)

      const result = yield* callAs(yield* mcp.connectionFor(a), "vm_pull_file", { path: "~/nope.txt" })
      expect(result.isError).toBe(true)
      expect(result.text).toContain("Nothing exists at ~/nope.txt in the VM.")
      expect(yield* vm.get(a)).toStrictEqual(started)
    }),
  )

  it.effect("a click waits while the user has control and skips its action on hand back", () =>
    Effect.gen(function* () {
      const mcp = yield* McpCredentials
      const vm = yield* TinyVm
      const fake = yield* FakeSbxServer
      const { a } = yield* Seeded
      yield* setTinyVm(true)
      yield* vm.start(a)
      expect(yield* vm.setControl(a, "user")).toMatchObject({ control: "user", agentWaiting: false })
      fake.inputs.length = 0
      const call = yield* Effect.forkChild(callAs(yield* mcp.connectionFor(a), "vm_click", { x: 10, y: 10 }))
      yield* until(
        Effect.map(vm.get(a), (current) =>
          current.status === "running" && current.control === "user" && current.agentWaiting
            ? Option.some(true)
            : Option.none(),
        ),
      )
      expect(call.pollUnsafe()).toBeUndefined()
      expect(fake.inputs).toStrictEqual([])

      yield* vm.setControl(a, "agent")
      const result = yield* Fiber.join(call)
      expect(result.isError).toBe(false)
      expect(result.text).toContain("handed it back")
      expect(result.images).toHaveLength(1)
      expect(fake.inputs).toStrictEqual([])
    }),
  )

  it.effect("a sandbox sbx destroyed makes the tool say so and resets the VM", () =>
    Effect.gen(function* () {
      const mcp = yield* McpCredentials
      const vm = yield* TinyVm
      const fake = yield* FakeSbxServer
      const { a } = yield* Seeded
      yield* setTinyVm(true)
      const running = yield* vm.start(a)
      if (running.status !== "running") throw new Error(`VM is ${running.status}`)
      fake.expire(running.sandboxId)
      const result = yield* callAs(yield* mcp.connectionFor(a), "vm_screenshot")
      expect(result.isError).toBe(true)
      expect(result.text).toContain("The VM was destroyed")
      expect(yield* vm.get(a)).toStrictEqual({ status: "none" })
    }),
  )

  it.effect("a screen stream relays the VNC server and hands control back when its window goes away", () =>
    Effect.gen(function* () {
      const vm = yield* TinyVm
      const { a } = yield* Seeded
      yield* setTinyVm(true)
      yield* vm.start(a)
      const owner = new EventEmitter()
      pushes.length = 0
      yield* vm.openScreen(a, "stream-1", owner)
      const duplicate = yield* Effect.flip(vm.openScreen(a, "stream-1", owner))
      expect(duplicate.message).toContain("already open")
      const greeting = yield* until(
        Effect.sync(() =>
          Option.fromNullishOr(pushes.find((push) => push.type === "vm.screen.data" && push.streamId === "stream-1")),
        ),
      )
      expect(greeting.type === "vm.screen.data" && Buffer.from(greeting.data).toString()).toBe("RFB 003.008\n")

      yield* vm.setControl(a, "user")
      owner.emit("destroyed")
      yield* until(
        Effect.sync(() =>
          pushes.some((push) => push.type === "vm.screen.closed" && push.streamId === "stream-1")
            ? Option.some(true)
            : Option.none(),
        ),
      )
      expect(yield* vm.get(a)).toMatchObject({ control: "user" })
      yield* advanceUntil(
        HAND_BACK_GRACE,
        Effect.map(vm.get(a), (current) =>
          current.status === "running" && current.control === "agent" ? Option.some(true) : Option.none(),
        ),
      )
      yield* vm.sendScreen("stream-1", new Uint8Array([1]))
    }),
  )

  it.effect("turning the toggle off destroys every VM", () =>
    Effect.gen(function* () {
      const vm = yield* TinyVm
      const fake = yield* FakeSbxServer
      const { a, b } = yield* Seeded
      yield* setTinyVm(true)
      yield* vm.start(a)
      yield* vm.start(b)
      yield* setTinyVm(false)
      yield* until(Effect.sync(() => (fake.sandboxes.size === 0 ? Option.some(true) : Option.none())))
      expect(yield* vm.get(a)).toStrictEqual({ status: "none" })
      expect(yield* vm.get(b)).toStrictEqual({ status: "none" })
    }),
  )
})

const instructionsOfNextTurn = (threadId: string) =>
  Effect.gen(function* () {
    const runner = yield* AgentRunner
    turnInputs.length = 0
    yield* until(
      runner.send(threadId, "hi", []).pipe(
        Effect.as(Option.some(true)),
        Effect.orElseSucceed(() => Option.none()),
      ),
    )
    const input = yield* until(
      Effect.sync(() => Option.fromNullishOr(turnInputs.find((turn) => turn.threadId === threadId))),
    )
    yield* runner.interrupt(threadId)
    return input.instructions
  })

layer(testLayer)("agent instructions", (it) => {
  it.effect("carry the tiny VM block only while the toggle is on", () =>
    Effect.gen(function* () {
      const { b } = yield* Seeded
      const off = yield* instructionsOfNextTurn(b)
      expect(off).toContain("<hinacode>")
      expect(off).not.toContain("<tiny-vm>")
      yield* setTinyVm(true)
      const on = yield* instructionsOfNextTurn(b)
      expect(on).toContain("<hinacode>")
      expect(on).toContain("<tiny-vm>")
    }),
  )
})
