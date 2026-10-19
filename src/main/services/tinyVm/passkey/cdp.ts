import { Effect, Schema } from "effect"
import { WebSocket } from "ws"
import { PasskeyError } from "./protocol.ts"

const TargetList = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    type: Schema.String,
    title: Schema.String,
    url: Schema.String,
  }),
)

const Version = Schema.Struct({ webSocketDebuggerUrl: Schema.String })

const EvaluateResult = Schema.Struct({
  result: Schema.Struct({ value: Schema.optional(Schema.Unknown) }),
  exceptionDetails: Schema.optional(
    Schema.Struct({
      text: Schema.String,
      exception: Schema.optional(Schema.Struct({ description: Schema.optional(Schema.String) })),
    }),
  ),
})

const fetchJson = (url: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json() as Promise<unknown>
    },
    catch: (cause) =>
      new PasskeyError({
        message: `Could not reach the browser DevTools endpoint at ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })

const withBaseHost = (baseUrl: string, socketUrl: string) => {
  const base = new URL(baseUrl)
  const socket = new URL(socketUrl)
  socket.protocol = base.protocol === "https:" ? "wss:" : "ws:"
  socket.host = base.host
  return socket.toString()
}

export const listTargets = (baseUrl: string) =>
  fetchJson(`${baseUrl}/json/list`).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(TargetList)),
    Effect.mapError((error) =>
      error instanceof PasskeyError
        ? error
        : new PasskeyError({ message: "The browser sent a DevTools target list HinaCode does not understand" }),
    ),
  )

export const browserSocketUrl = (baseUrl: string) =>
  fetchJson(`${baseUrl}/json/version`).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Version)),
    Effect.map((version) => withBaseHost(baseUrl, version.webSocketDebuggerUrl)),
    Effect.mapError((error) =>
      error instanceof PasskeyError
        ? error
        : new PasskeyError({ message: "The browser sent a DevTools version HinaCode does not understand" }),
    ),
  )

type Listener = (params: unknown, sessionId: string | undefined) => void

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: PasskeyError) => void
}

export class CdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private closed = false
  private readonly socket: WebSocket
  onClose: (() => void) | undefined

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.on("message", (data) => this.receive(data.toString()))
    socket.on("error", () => {})
    socket.on("close", () => {
      if (this.closed) return
      this.closed = true
      const error = new PasskeyError({ message: "The DevTools connection closed" })
      this.pending.forEach(({ reject }) => reject(error))
      this.pending.clear()
      this.onClose?.()
    })
  }

  static connect(url: string): Effect.Effect<CdpConnection, PasskeyError> {
    return Effect.callback((resume) => {
      const socket = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 })
      const fail = (cause: Error) =>
        resume(
          Effect.fail(
            new PasskeyError({ message: `Could not connect to the browser DevTools socket: ${cause.message}` }),
          ),
        )
      socket.once("error", fail)
      socket.once("open", () => {
        socket.off("error", fail)
        resume(Effect.succeed(new CdpConnection(socket)))
      })
      return Effect.sync(() => socket.close())
    })
  }

  private receive(text: string) {
    let message: {
      id?: unknown
      method?: unknown
      params?: unknown
      result?: unknown
      error?: unknown
      sessionId?: unknown
    }
    try {
      message = JSON.parse(text) as typeof message
    } catch {
      return
    }
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (message.error === undefined) pending.resolve(message.result)
      else {
        const detail =
          typeof message.error === "object" && message.error !== null && "message" in message.error
            ? String((message.error as { message: unknown }).message)
            : "unknown DevTools error"
        pending.reject(new PasskeyError({ message: `DevTools call failed: ${detail}` }))
      }
      return
    }
    if (typeof message.method === "string") {
      this.listeners.get(message.method)?.forEach((listener) => listener(message.params, sessionId))
    }
  }

  call(method: string, params: Record<string, unknown> = {}, sessionId?: string): Effect.Effect<unknown, PasskeyError> {
    return Effect.callback((resume) => {
      if (this.closed) {
        resume(Effect.fail(new PasskeyError({ message: "The DevTools connection closed" })))
        return
      }
      const id = this.nextId++
      this.pending.set(id, {
        resolve: (value) => resume(Effect.succeed(value)),
        reject: (error) => resume(Effect.fail(error)),
      })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
      return Effect.sync(() => this.pending.delete(id))
    })
  }

  on(method: string, listener: Listener): void {
    let set = this.listeners.get(method)
    if (set === undefined) this.listeners.set(method, (set = new Set()))
    set.add(listener)
  }

  evaluate(
    sessionId: string | undefined,
    expression: string,
    awaitPromise = false,
  ): Effect.Effect<unknown, PasskeyError> {
    return this.call(
      "Runtime.evaluate",
      { expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true },
      sessionId,
    ).pipe(
      Effect.flatMap((raw) => {
        const decoded = Schema.decodeUnknownOption(EvaluateResult)(raw)
        if (decoded._tag === "None") {
          return Effect.fail(
            new PasskeyError({ message: "The browser sent an evaluation result HinaCode does not understand" }),
          )
        }
        const exception = decoded.value.exceptionDetails
        if (exception !== undefined) {
          return Effect.fail(new PasskeyError({ message: exception.exception?.description ?? exception.text }))
        }
        return Effect.succeed(decoded.value.result.value)
      }),
    )
  }

  close(): void {
    this.socket.close()
  }
}

const SessionId = Schema.Struct({ sessionId: Schema.String })

export const attachToTarget = (connection: CdpConnection, targetId: string) =>
  connection.call("Target.attachToTarget", { targetId, flatten: true }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SessionId)),
    Effect.map(({ sessionId }) => sessionId),
    Effect.mapError((error) =>
      error instanceof PasskeyError
        ? error
        : new PasskeyError({ message: "The browser sent an attach result HinaCode does not understand" }),
    ),
  )
