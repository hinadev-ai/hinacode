import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { Effect, Queue } from "effect"
import { type WebSocket, WebSocketServer } from "ws"

export interface FakeWorkspace {
  readonly appToken: string
  readonly botToken: string
  readonly team: { readonly id: string; readonly name: string }
  readonly bot: string
  readonly users: Readonly<
    Record<
      string,
      { readonly team_id: string; readonly name: string; readonly real_name?: string; readonly is_bot?: boolean }
    >
  >
}

export interface FakeReaction {
  readonly channel: string
  readonly timestamp: string
  readonly name: string
}

const start = (workspace: FakeWorkspace) =>
  Effect.callback<FakeSlack>((resume) => {
    const links = Effect.runSync(Queue.unbounded<WebSocket>())
    const acks = Effect.runSync(Queue.unbounded<string>())
    const reactions = Effect.runSync(Queue.unbounded<FakeReaction>())
    const open = new Set<WebSocket>()
    let appTokenRevoked = false

    const answer = (method: string, token: string, params: URLSearchParams): object => {
      switch (method) {
        case "auth.test":
          return token === workspace.botToken
            ? { ok: true, team_id: workspace.team.id, team: workspace.team.name, user: workspace.bot }
            : { ok: false, error: "invalid_auth" }
        case "apps.connections.open":
          return token === workspace.appToken && !appTokenRevoked
            ? { ok: true, url: `ws://127.0.0.1:${(http.address() as AddressInfo).port}/link` }
            : { ok: false, error: "invalid_auth" }
        case "users.info": {
          const user = workspace.users[params.get("user") ?? ""]
          return user === undefined ? { ok: false, error: "user_not_found" } : { ok: true, user }
        }
        case "reactions.add":
          Queue.offerUnsafe(reactions, {
            channel: params.get("channel") ?? "",
            timestamp: params.get("timestamp") ?? "",
            name: params.get("name") ?? "",
          })
          return { ok: true }
        default:
          return { ok: false, error: "unknown_method" }
      }
    }

    const http = createServer((request, response) => {
      const chunks: Array<Buffer> = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        const method = (request.url ?? "").replace(/^\/api\//, "")
        const token = (request.headers.authorization ?? "").replace(/^Bearer /, "")
        const params = new URLSearchParams(Buffer.concat(chunks).toString())
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify(answer(method, token, params)))
      })
    })
    const sockets = new WebSocketServer({ server: http })
    sockets.on("connection", (socket) => {
      open.add(socket)
      socket.on("close", () => open.delete(socket))
      socket.on("message", (data) => {
        const { envelope_id } = JSON.parse(data.toString()) as { readonly envelope_id: string }
        Queue.offerUnsafe(acks, envelope_id)
      })
      socket.send(JSON.stringify({ type: "hello" }))
      Queue.offerUnsafe(links, socket)
    })

    http.listen(0, "127.0.0.1", () =>
      resume(
        Effect.succeed({
          apiUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/`,
          links,
          acks,
          reactions,
          deliver: (payload: unknown) =>
            Effect.sync(() => {
              const envelope_id = randomUUID()
              const message = JSON.stringify({ envelope_id, type: "events_api", payload })
              for (const socket of open) socket.send(message)
              return envelope_id
            }),
          askToRefresh: Effect.sync(() => {
            for (const socket of open) socket.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }))
          }),
          drop: Effect.sync(() => {
            for (const socket of open) socket.close()
          }),
          revokeAppToken: Effect.sync(() => {
            appTokenRevoked = true
          }),
          close: Effect.callback<void>((closed) => {
            for (const socket of open) socket.terminate()
            sockets.close()
            http.close(() => closed(Effect.void))
            http.closeAllConnections()
          }),
        }),
      ),
    )
  })

export interface FakeSlack {
  readonly apiUrl: string
  readonly links: Queue.Queue<WebSocket>
  readonly acks: Queue.Queue<string>
  readonly reactions: Queue.Queue<FakeReaction>
  readonly deliver: (payload: unknown) => Effect.Effect<string>
  readonly askToRefresh: Effect.Effect<void>
  readonly drop: Effect.Effect<void>
  readonly revokeAppToken: Effect.Effect<void>
  readonly close: Effect.Effect<void>
}

export const makeFakeSlack = (workspace: FakeWorkspace) => Effect.acquireRelease(start(workspace), (fake) => fake.close)
