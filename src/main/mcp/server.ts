import { createServer } from "node:http"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { Effect, Layer, Option } from "effect"
import { McpProtocol, McpServer as AiMcpServer } from "effect/ai"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { McpCredentials } from "./credentials.ts"
import * as Tools from "./tools/index.ts"

const MCP_PATH = "/mcp"

/** Rejects requests without a credential for an existing thread, so other local processes cannot act as a thread. */
const requireCredential = HttpRouter.middleware(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const credentials = yield* McpCredentials
    const threadExists = (threadId: string) =>
      sql`SELECT 1 FROM thread WHERE id = ${threadId}`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orElseSucceed(() => false),
      )
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const threadId = credentials.authenticate(request.headers["authorization"])
        if (Option.isNone(threadId) || !(yield* threadExists(threadId.value))) {
          return HttpServerResponse.jsonUnsafe({ error: "invalid_token" }, { status: 401 })
        }
        return yield* httpEffect
      })
  }),
  { global: true },
)

const httpServer = HttpRouter.serve(
  Layer.mergeAll(Tools.layer, requireCredential).pipe(
    Layer.provideMerge(
      AiMcpServer.layerHttp({
        name: "hinacode",
        version: "0.1.0",
        path: MCP_PATH,
        protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
        allowSessionTermination: true,
      }),
    ),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })))

/** Tells the credential store where the server listens, so turns can be handed a connection. */
const announce = Layer.effectDiscard(
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer
    if (address._tag === "UnixPathAddress") return yield* Effect.die("MCP server must listen on TCP")
    const url = `http://127.0.0.1:${address.port}${MCP_PATH}`
    yield* Effect.logInfo("mcp server listening", url)
    yield* (yield* McpCredentials).listening(url)
  }),
)

/**
 * The built-in MCP server agents call back into. One HTTP listener on 127.0.0.1 for the whole app;
 * each thread gets its own bearer credential from `McpCredentials`, and the credential alone decides
 * which thread a call acts as.
 */
export const layer = announce.pipe(Layer.provide(httpServer))
