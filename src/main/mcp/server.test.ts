import assert from "node:assert/strict"
import { after, before, describe, mock, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Context, Effect, Exit, Layer, Option, Scope } from "effect"
import { SqlClient } from "effect/sql"

mock.module("electron", { exports: { BrowserWindow: {}, safeStorage: {} } })
const { McpServer, layer } = await import("./server.ts")
const { PullRequests } = await import("../services/PullRequests.ts")
const { Secrets } = await import("../services/Secrets.ts")

const listedThreads: Array<string> = []

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
  Layer.succeed(SqlClient.SqlClient, {} as SqlClient.SqlClient),
)

const scope = Effect.runSync(Scope.make())
let mcp: typeof McpServer.Service

before(async () => {
  const context = await Effect.runPromise(Layer.buildWithScope(layer.pipe(Layer.provide(stubs)), scope))
  mcp = Context.get(context, McpServer)
})
after(() => Effect.runPromise(Scope.close(scope, Exit.void)))

/** Calls `list_thread_pull_requests` and returns the thread ids the tool acted on. */
const listAs = async (url: string, headers: Record<string, string> = {}) => {
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

const withThreadParam = (url: string, threadId: string) => {
  const forged = new URL(url)
  forged.searchParams.set("thread", threadId)
  return forged.toString()
}

describe("mcp server credentials", () => {
  test("a credential acts only as the thread it was issued for", async () => {
    assert.deepEqual(await listAs(mcp.urlForThread("thread-a")), ["thread-a"])
  })

  test("changing the thread parameter does not change identity", async () => {
    const forged = withThreadParam(mcp.urlForThread("thread-a"), "thread-b")
    const acted = await listAs(forged).catch((): Array<string> => [])
    assert.ok(!acted.includes("thread-b"), `thread A's credential acted as ${acted.join(", ")}`)
  })
})
