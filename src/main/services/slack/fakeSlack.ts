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

export const FAKE_BOT_USER_ID = "UBOT"

export interface FakeMessage {
  readonly channel: string
  readonly ts: string
  readonly thread_ts?: string
  readonly user: string
  readonly text: string
}

export interface FakeNote {
  readonly channel: string
  readonly user: string
  readonly text: string
  readonly thread_ts: string | null
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
    const notes = Effect.runSync(Queue.unbounded<FakeNote>())
    const threads = new Map<string, Array<FakeMessage>>()
    const held = Effect.runSync(Queue.unbounded<() => void>())
    let holding: string | null = null
    const open = new Set<WebSocket>()
    let appTokenRevoked = false

    const answer = (method: string, token: string, params: URLSearchParams): object => {
      switch (method) {
        case "auth.test":
          return token === workspace.botToken
            ? {
                ok: true,
                team_id: workspace.team.id,
                team: workspace.team.name,
                user: workspace.bot,
                user_id: FAKE_BOT_USER_ID,
              }
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
        case "conversations.replies": {
          const messages = threads.get(`${params.get("channel")}:${params.get("ts")}`)
          return messages === undefined ? { ok: false, error: "thread_not_found" } : { ok: true, messages }
        }
        case "chat.getPermalink":
          return {
            ok: true,
            permalink: `https://acme.slack.com/archives/${params.get("channel")}/p${(params.get("message_ts") ?? "").replace(".", "")}`,
          }
        case "chat.postEphemeral":
          Queue.offerUnsafe(notes, {
            channel: params.get("channel") ?? "",
            user: params.get("user") ?? "",
            text: params.get("text") ?? "",
            thread_ts: params.get("thread_ts"),
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
        const reply = () => response.end(JSON.stringify(answer(method, token, params)))
        if (method === holding) Queue.offerUnsafe(held, reply)
        else reply()
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
          notes,
          held,
          hold: (method: string | null) =>
            Effect.sync(() => {
              holding = method
            }),
          post: (message: FakeMessage) =>
            Effect.sync(() => {
              const root = `${message.channel}:${message.thread_ts ?? message.ts}`
              threads.set(root, [...(threads.get(root) ?? []), message])
            }),
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
  readonly notes: Queue.Queue<FakeNote>
  readonly held: Queue.Queue<() => void>
  readonly hold: (method: string | null) => Effect.Effect<void>
  readonly post: (message: FakeMessage) => Effect.Effect<void>
  readonly deliver: (payload: unknown) => Effect.Effect<string>
  readonly askToRefresh: Effect.Effect<void>
  readonly drop: Effect.Effect<void>
  readonly revokeAppToken: Effect.Effect<void>
  readonly close: Effect.Effect<void>
}

export const makeFakeSlack = (workspace: FakeWorkspace) => Effect.acquireRelease(start(workspace), (fake) => fake.close)
