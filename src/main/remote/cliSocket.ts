import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs"
import { createConnection } from "node:net"
import { dirname } from "node:path"
import { Cause, Effect, Layer } from "effect"
import type { WebSocket } from "ws"
import { route } from "../environments/route.ts"
import { WindowBroadcast } from "../services/Events.ts"
import { CLOSE_MALFORMED_FRAME, RemoteAccess } from "./access.ts"
import { cliSocketPath } from "./cliSocketPath.ts"
import { listenWebSockets, makeSessions, readFrame } from "./session.ts"

const someoneAnswers = (socketPath: string) =>
  Effect.callback<boolean, Error>((resume) => {
    const probe = createConnection(socketPath)
    probe.once("connect", () => {
      probe.destroy()
      resume(Effect.succeed(true))
    })
    probe.once("error", (error: NodeJS.ErrnoException) =>
      resume(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? Effect.succeed(false) : Effect.fail(error)),
    )
  })

const makePrivate = (folder: string) => {
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  if (statSync(folder).uid !== process.getuid?.()) return false
  chmodSync(folder, 0o700)
  return true
}

const make = (dataDir: string) =>
  Effect.gen(function* () {
    const socketPath = cliSocketPath(dataDir)
    const access = yield* RemoteAccess
    const windows = yield* WindowBroadcast
    const sessions = yield* makeSessions({
      call: (raw) => route(raw, null),
      subscribe: windows.subscribe,
      environment: access.identity,
      features: ["heartbeat", "call-keys", "terminal-attach", "watch"],
    })

    const accept = (socket: WebSocket) => {
      socket.on("error", () => {})
      socket.on("message", (raw, isBinary) => {
        const frame = readFrame(socket, raw, isBinary)
        if (frame === undefined) return
        if (frame.type === "auth" || frame.type === "hub" || frame.type === "answer")
          return socket.close(CLOSE_MALFORMED_FRAME, "malformed frame")
        sessions.receive(socket, frame)
      })
      sessions.attach(socket, { compactEvents: true })
    }

    yield* Effect.gen(function* () {
      if (!makePrivate(dirname(socketPath)))
        return yield* Effect.logWarning("cli socket refused: another user owns its folder", dirname(socketPath))
      if (yield* someoneAnswers(socketPath))
        return yield* Effect.logWarning(`another HinaCode listens on ${socketPath}`)
      rmSync(socketPath, { force: true })
      yield* listenWebSockets({
        listen: (server, listening) => server.listen(socketPath, listening),
        accept,
        perMessageDeflate: false,
      })
      chmodSync(socketPath, 0o600)
      yield* Effect.logInfo("cli socket listening", socketPath)
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("cli socket failed", Cause.pretty(cause))))
  })

export const layer = (dataDir: string) =>
  process.platform === "win32" ? Layer.empty : Layer.effectDiscard(make(dataDir))
