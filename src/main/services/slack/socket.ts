import { Duration, Effect, FiberSet, Option, Schema } from "effect"
import { WebSocket } from "ws"
import { backoffMs, retryWhileRecoverable, type SlackApiError } from "./api.ts"

const SERVER_SILENCE_MS = 30_000
const HANDSHAKE_TIMEOUT_MS = 15_000

const Frame = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ type: Schema.Literals(["hello", "disconnect"]) }),
    Schema.Struct({ type: Schema.String, envelope_id: Schema.String, payload: Schema.optionalKey(Schema.Unknown) }),
  ]),
)
const decodeFrame = Schema.decodeUnknownOption(Frame)

export interface SlackEnvelope {
  readonly type: string
  readonly payload: unknown
}

export interface SocketOptions {
  readonly open: Effect.Effect<string, SlackApiError>
  readonly onLive: (live: boolean) => void
  readonly onEnvelope: (envelope: SlackEnvelope) => Effect.Effect<void>
  readonly serverSilenceMs?: number
  readonly handshakeTimeoutMs?: number
}

export const listen = ({
  open,
  onLive,
  onEnvelope,
  serverSilenceMs = SERVER_SILENCE_MS,
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
}: SocketOptions) =>
  Effect.gen(function* () {
    const connections = yield* FiberSet.make<void, SlackApiError>()
    const start = yield* FiberSet.runtime(connections)<never>()
    const handle = yield* FiberSet.makeRuntime<never, void, never>()
    let live = 0
    let failures = 0

    const pause = Effect.suspend(() => {
      failures += 1
      return Effect.sleep(Duration.millis(backoffMs(failures - 1)))
    })

    const serve = (address: string, replace: () => void) =>
      Effect.callback<void>((resume) => {
        const socket = new WebSocket(address, { handshakeTimeout: handshakeTimeoutMs })
        let greeted = false
        let silence: NodeJS.Timeout | undefined
        const heard = () => {
          clearTimeout(silence)
          silence = setTimeout(() => socket.terminate(), serverSilenceMs)
        }
        socket.on("open", heard)
        socket.on("ping", heard)
        socket.on("error", () => undefined)
        socket.on("message", (data) => {
          heard()
          const frame = decodeFrame(data.toString())
          if (Option.isNone(frame)) return
          if ("envelope_id" in frame.value) {
            socket.send(JSON.stringify({ envelope_id: frame.value.envelope_id }))
            handle(onEnvelope({ type: frame.value.type, payload: frame.value.payload }))
            return
          }
          if (frame.value.type === "disconnect") return replace()
          if (greeted) return
          greeted = true
          failures = 0
          live += 1
          onLive(true)
        })
        socket.on("close", () => {
          clearTimeout(silence)
          if (greeted) {
            live -= 1
            onLive(live > 0)
          }
          resume(Effect.void)
        })
        return Effect.sync(() => {
          clearTimeout(silence)
          socket.removeAllListeners()
          socket.on("error", () => undefined)
          socket.terminate()
        })
      })

    const connect: Effect.Effect<void, SlackApiError> = Effect.gen(function* () {
      const address = yield* retryWhileRecoverable(open)
      let replaced = false
      const replace = () => {
        if (replaced) return
        replaced = true
        start(connect)
      }
      yield* serve(address, replace)
      if (replaced) return
      yield* pause
      replace()
    })

    start(connect)
    return yield* FiberSet.join(connections)
  }).pipe(Effect.scoped)
