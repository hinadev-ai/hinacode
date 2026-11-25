import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { Effect, Queue } from "effect"
import { type WebSocket, WebSocketServer } from "ws"

export interface FakeWorkspace {
  readonly appToken: string
  readonly botToken: string
  readonly team: { readonly id: string; readonly name: string; readonly url: string }
  readonly bot: string
}

export const FAKE_BOT_USER_ID = "UBOT"

export interface FakeMessage {
  readonly channel: string
  readonly ts: string
  readonly thread_ts?: string
  readonly user: string
  readonly text: string
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
    const posts = Effect.runSync(Queue.unbounded<FakeMessage>())
    const threads = new Map<string, Array<FakeMessage>>()
    const failing = new Set<string>()
    const called = new Map<string, number>()
    const open = new Set<WebSocket>()
    let appTokenRevoked = false

    const answer = (method: string, token: string, params: URLSearchParams): object => {
      called.set(method, (called.get(method) ?? 0) + 1)
      if (failing.has(method)) return { ok: false, error: "internal_error" }
      if (method !== "apps.connections.open" && token !== workspace.botToken)
        return { ok: false, error: "invalid_auth" }
      switch (method) {
        case "auth.test":
          return {
            ok: true,
            url: workspace.team.url,
            team_id: workspace.team.id,
            team: workspace.team.name,
            user: workspace.bot,
            user_id: FAKE_BOT_USER_ID,
          }
        case "apps.connections.open":
          return token === workspace.appToken && !appTokenRevoked
            ? { ok: true, url: `ws://127.0.0.1:${(http.address() as AddressInfo).port}/link` }
            : { ok: false, error: "invalid_auth" }
        case "reactions.add":
          Queue.offerUnsafe(reactions, {
            channel: params.get("channel") ?? "",
            timestamp: params.get("timestamp") ?? "",
            name: params.get("name") ?? "",
          })
          return { ok: true }
        case "conversations.replies": {
          const messages = threads.get(`${params.get("channel")}:${params.get("ts")}`)
          return messages === undefined ? { ok: false, error: "thread_not_found" } : { ok: true, messages }
        }
        case "chat.postMessage": {
          const root = `${params.get("channel")}:${params.get("thread_ts")}`
          const replies = threads.get(root)
          if (replies === undefined) return { ok: false, error: "thread_not_found" }
          const ts = `${1800000000 + replies.length}.000100`
          const posted = {
            channel: params.get("channel") ?? "",
            ts,
            thread_ts: params.get("thread_ts") ?? "",
            user: FAKE_BOT_USER_ID,
            text: params.get("markdown_text") ?? "",
          }
          replies.push(posted)
          Queue.offerUnsafe(posts, posted)
          return { ok: true, ts }
        }
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

    const post = (message: FakeMessage) =>
      Effect.sync(() => {
        const root = `${message.channel}:${message.thread_ts ?? message.ts}`
        threads.set(root, [...(threads.get(root) ?? []), message])
      })

    const deliver = (payload: unknown) =>
      Effect.sync(() => {
        const envelope_id = randomUUID()
        const envelope = JSON.stringify({ envelope_id, type: "events_api", payload })
        for (const socket of open) socket.send(envelope)
        return envelope_id
      })

    http.listen(0, "127.0.0.1", () =>
      resume(
        Effect.succeed({
          apiUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/`,
          links,
          acks,
          reactions,
          posts,
          fail: (method: string) => Effect.sync(() => void failing.add(method)),
          called: (method: string) => Effect.sync(() => called.get(method) ?? 0),
          post,
          deliver,
          mention: (message: FakeMessage) =>
            Effect.andThen(
              post(message),
              deliver({ team_id: workspace.team.id, event: { type: "app_mention", ...message } }),
            ),
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
  readonly posts: Queue.Queue<FakeMessage>
  readonly fail: (method: string) => Effect.Effect<void>
  readonly called: (method: string) => Effect.Effect<number>
  readonly post: (message: FakeMessage) => Effect.Effect<void>
  readonly deliver: (payload: unknown) => Effect.Effect<string>
  readonly mention: (message: FakeMessage) => Effect.Effect<string>
  readonly askToRefresh: Effect.Effect<void>
  readonly drop: Effect.Effect<void>
  readonly revokeAppToken: Effect.Effect<void>
  readonly close: Effect.Effect<void>
}

export const makeFakeSlack = (workspace: FakeWorkspace) => Effect.acquireRelease(start(workspace), (fake) => fake.close)
