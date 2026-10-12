import { expect, layer } from "@effect/vitest"
import { vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Context, Effect, Layer, Option } from "effect"
import type { McpConnection } from "../../shared/agent.ts"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import { PullRequests } from "../services/PullRequests.ts"
import { Secrets } from "../services/Secrets.ts"
import { McpServer, layer as serverLayer } from "./server.ts"

vi.mock("electron", () => ({ BrowserWindow: {}, safeStorage: {} }))

const listedThreads: Array<string> = []

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

const stubs = Layer.mergeAll(
  Layer.succeed(PullRequests, {
    list: (threadId) => Effect.sync(() => (listedThreads.push(threadId), [])),
    listAll: Effect.succeed([]),
    link: (_, url) => Effect.succeed(url),
    unlink: () => Effect.void,
    create: () => Effect.die("not used"),
  }),
  Layer.succeed(Secrets, {
    get: () => Effect.succeed(Option.none()),
    has: () => Effect.succeed(false),
    set: () => Effect.void,
    clear: () => Effect.void,
  }),
)

const testLayer = Layer.mergeAll(serverLayer.pipe(Layer.provide(stubs)), seeded).pipe(
  Layer.provideMerge(Db.layer(":memory:")),
)

/** Calls `list_thread_pull_requests` and returns the thread ids the tool acted on. */
const listAs = ({ url, headers }: McpConnection) =>
  Effect.tryPromise(async () => {
    listedThreads.length = 0
    const client = new Client({ name: "test", version: "0" })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
    try {
      await client.callTool({ name: "list_thread_pull_requests", arguments: {} })
    } finally {
      await client.close()
    }
    return [...listedThreads]
  })

/** Passes only when the server turns the connection away. */
const rejects = (connection: McpConnection) => Effect.flip(listAs(connection))

const withAuthorization = (connection: McpConnection, authorization: string) => ({
  ...connection,
  headers: { authorization },
})

// The HTTP server runs on the live clock; the test services would freeze its timeouts.
layer(testLayer, { excludeTestServices: true })("mcp server credentials", (it) => {
  it.effect("a credential acts only as the thread it was issued for", () =>
    Effect.gen(function* () {
      const mcp = yield* McpServer
      const { a, b } = yield* Seeded
      expect(yield* listAs(mcp.connectionFor(a))).toStrictEqual([a])
      expect(yield* listAs(mcp.connectionFor(b))).toStrictEqual([b])
    }),
  )

  it.effect("changing the thread parameter does not change identity", () =>
    Effect.gen(function* () {
      const mcp = yield* McpServer
      const { a, b } = yield* Seeded
      const connection = mcp.connectionFor(a)
      const forged = new URL(connection.url)
      forged.searchParams.set("thread", b)
      const acted = yield* listAs({ ...connection, url: forged.toString() }).pipe(
        Effect.orElseSucceed((): Array<string> => []),
      )
      expect(acted, `thread A's credential acted as ${acted.join(", ")}`).not.toContain(b)
    }),
  )

  it.effect("a thread's secret does not authenticate another thread", () =>
    Effect.gen(function* () {
      const mcp = yield* McpServer
      const { a, b } = yield* Seeded
      const connection = mcp.connectionFor(a)
      mcp.connectionFor(b)
      const relabeled = connection.headers.authorization.replace(`${a}.`, `${b}.`)
      yield* rejects(withAuthorization(connection, relabeled))
    }),
  )

  it.effect("unknown credentials are rejected", () =>
    Effect.gen(function* () {
      const mcp = yield* McpServer
      const { a } = yield* Seeded
      const connection = mcp.connectionFor(a)
      yield* rejects(withAuthorization(connection, `Bearer ${a}.not-the-secret`))
      yield* rejects(withAuthorization(connection, "Bearer no-such-thread.secret"))
      yield* rejects(withAuthorization(connection, ""))
    }),
  )

  it.effect("a thread that is not in the database gets no access", () =>
    Effect.gen(function* () {
      const mcp = yield* McpServer
      yield* rejects(mcp.connectionFor("thread-gone"))
    }),
  )
})
