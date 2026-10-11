import { expect, layer } from "@effect/vitest"
import { vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import type { McpConnection } from "../../shared/agent.ts"
import { PullRequests } from "../services/PullRequests.ts"
import { Secrets } from "../services/Secrets.ts"
import { McpServer, layer as serverLayer } from "./server.ts"

vi.mock("electron", () => ({ BrowserWindow: {}, safeStorage: {} }))

const listedThreads: Array<string> = []
const existingThreads = new Set(["thread-a", "thread-b"])

const threadLookup = (_: TemplateStringsArray, threadId: string) =>
  Effect.succeed(existingThreads.has(threadId) ? [{}] : [])

const stubs = Layer.mergeAll(
  Layer.succeed(PullRequests, {
    list: (threadId) => Effect.sync(() => (listedThreads.push(threadId), [])),
    link: (_, url) => Effect.succeed(url),
    unlink: () => Effect.void,
  }),
  Layer.succeed(Secrets, {
    get: () => Effect.succeed(Option.none()),
    has: () => Effect.succeed(false),
    set: () => Effect.void,
    clear: () => Effect.void,
  }),
  Layer.succeed(SqlClient.SqlClient, threadLookup as unknown as SqlClient.SqlClient),
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
layer(serverLayer.pipe(Layer.provide(stubs)), { excludeTestServices: true })("mcp server credentials", (it) => {
  it.effect("a credential acts only as the thread it was issued for", () =>
    Effect.gen(function* () {
      const mcp = yield* McpServer
      expect(yield* listAs(mcp.connectionFor("thread-a"))).toStrictEqual(["thread-a"])
      expect(yield* listAs(mcp.connectionFor("thread-b"))).toStrictEqual(["thread-b"])
    }),
  )

  it.effect("changing the thread parameter does not change identity", () =>
    Effect.gen(function* () {
      const mcp = yield* McpServer
      const connection = mcp.connectionFor("thread-a")
      const forged = new URL(connection.url)
      forged.searchParams.set("thread", "thread-b")
      const acted = yield* listAs({ ...connection, url: forged.toString() }).pipe(
        Effect.orElseSucceed((): Array<string> => []),
      )
      expect(acted, `thread A's credential acted as ${acted.join(", ")}`).not.toContain("thread-b")
    }),
  )

  it.effect("a thread's secret does not authenticate another thread", () =>
    Effect.gen(function* () {
      const mcp = yield* McpServer
      const a = mcp.connectionFor("thread-a")
      mcp.connectionFor("thread-b")
      const relabeled = a.headers.authorization.replace("thread-a.", "thread-b.")
      yield* rejects(withAuthorization(a, relabeled))
    }),
  )

  it.effect("unknown credentials are rejected", () =>
    Effect.gen(function* () {
      const mcp = yield* McpServer
      const a = mcp.connectionFor("thread-a")
      yield* rejects(withAuthorization(a, "Bearer thread-a.not-the-secret"))
      yield* rejects(withAuthorization(a, "Bearer no-such-thread.secret"))
      yield* rejects(withAuthorization(a, ""))
    }),
  )

  it.effect("a deleted thread's credential is rejected", () =>
    Effect.gen(function* () {
      const mcp = yield* McpServer
      yield* rejects(mcp.connectionFor("thread-gone"))
    }),
  )
})
