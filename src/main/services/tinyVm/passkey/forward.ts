import { createServer, type Socket } from "node:net"
import { Effect } from "effect"
import { PasskeyError } from "./protocol.ts"

export interface TunnelSocket {
  readonly socket: Socket
  readonly head: Uint8Array
}

export interface Forward {
  readonly baseUrl: string
  readonly close: Effect.Effect<void>
}

/**
 * Listens on a loopback port on this Mac and pipes each connection into one sbx tunnel to the guest port.
 * DevTools HTTP and its WebSocket are separate TCP connections, so each one gets its own tunnel.
 */
export const startForward = (
  openTunnel: () => Effect.Effect<TunnelSocket, PasskeyError>,
): Effect.Effect<Forward, PasskeyError> =>
  Effect.callback((resume) => {
    const sockets = new Set<Socket>()
    const track = (socket: Socket) => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
      socket.on("error", () => {})
    }
    const server = createServer((local) => {
      track(local)
      Effect.runFork(
        openTunnel().pipe(
          Effect.tap(({ socket, head }) =>
            Effect.sync(() => {
              track(socket)
              if (local.destroyed) {
                socket.destroy()
                return
              }
              if (head.length > 0) local.write(head)
              socket.pipe(local)
              local.pipe(socket)
              local.once("close", () => socket.destroy())
              socket.once("close", () => local.destroy())
            }),
          ),
          Effect.catch(() => Effect.sync(() => local.destroy())),
        ),
      )
    })
    const close = Effect.sync(() => {
      sockets.forEach((socket) => socket.destroy())
      server.close()
    })
    server.once("error", (cause) =>
      resume(Effect.fail(new PasskeyError({ message: `Could not open a local forward port: ${cause.message}` }))),
    )
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        resume(Effect.fail(new PasskeyError({ message: "Could not open a local forward port" })))
        return
      }
      resume(Effect.succeed({ baseUrl: `http://127.0.0.1:${address.port}`, close }))
    })
    return close
  })
