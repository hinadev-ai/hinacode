import assert from "node:assert/strict"
import { after, before, describe, mock, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Context, Effect, Exit, Layer, Option, Scope } from "effect"
import { SqlClient } from "effect/sql"
import type { McpConnection } from "../../shared/agent.ts"

mock.module("electron", { exports: { BrowserWindow: {}, safeStorage: {} } })
const { McpServer, layer } = await import("./server.ts")
const { PullRequests } = await import("../services/PullRequests.ts")
const { Secrets } = await import("../services/Secrets.ts")

const listedThreads: Array<string> = []
const existingThreads = new Set(["thread-a", "thread-b"])

const threadLookup = (_: TemplateStringsArray, threadId: string) =>
  Effect.succeed(existingThreads.has(threadId) ? [{}] : [])

const stubs = Layer.mergeAll(
  Layer.succeed(PullRequests, {
    list: (threadId) => Effect.sync(() => (listedThreads.push(threadId), [])),
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
  Layer.succeed(SqlClient.SqlClient, threadLookup as unknown as SqlClient.SqlClient),
)

const scope = Effect.runSync(Scope.make())
let mcp: typeof McpServer.Service

before(async () => {
  const context = await Effect.runPromise(Layer.buildWithScope(layer.pipe(Layer.provide(stubs)), scope))
  mcp = Context.get(context, McpServer)
})
after(() => Effect.runPromise(Scope.close(scope, Exit.void)))

/** Calls `list_thread_pull_requests` and returns the thread ids the tool acted on. */
const listAs = async ({ url, headers }: McpConnection) => {
  listedThreads.length = 0
  const client = new Client({ name: "test", version: "0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
  try {
    await client.callTool({ name: "list_thread_pull_requests", arguments: {} })
  } finally {
    await client.close()
  }
  return [...listedThreads]
}

const withAuthorization = (connection: McpConnection, authorization: string) => ({
  ...connection,
  headers: { authorization },
})

describe("mcp server credentials", () => {
  test("a credential acts only as the thread it was issued for", async () => {
    assert.deepEqual(await listAs(mcp.connectionFor("thread-a")), ["thread-a"])
    assert.deepEqual(await listAs(mcp.connectionFor("thread-b")), ["thread-b"])
  })

  test("changing the thread parameter does not change identity", async () => {
    const connection = mcp.connectionFor("thread-a")
    const forged = new URL(connection.url)
    forged.searchParams.set("thread", "thread-b")
    const acted = await listAs({ ...connection, url: forged.toString() }).catch((): Array<string> => [])
    assert.ok(!acted.includes("thread-b"), `thread A's credential acted as ${acted.join(", ")}`)
  })

  test("a thread's secret does not authenticate another thread", async () => {
    const a = mcp.connectionFor("thread-a")
    mcp.connectionFor("thread-b")
    const relabeled = a.headers.authorization.replace("thread-a.", "thread-b.")
    await assert.rejects(listAs(withAuthorization(a, relabeled)))
  })

  test("unknown credentials are rejected", async () => {
    const a = mcp.connectionFor("thread-a")
    await assert.rejects(listAs(withAuthorization(a, "Bearer thread-a.not-the-secret")))
    await assert.rejects(listAs(withAuthorization(a, "Bearer no-such-thread.secret")))
    await assert.rejects(listAs(withAuthorization(a, "")))
  })

  test("a deleted thread's credential is rejected", async () => {
    const gone = mcp.connectionFor("thread-gone")
    await assert.rejects(listAs(gone))
  })
})
