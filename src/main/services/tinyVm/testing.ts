import { randomUUID } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Option, Schema } from "effect"

/** A client-to-server RFB input message, decoded. */
export type RfbEvent =
  | { readonly type: "pointer"; readonly x: number; readonly y: number; readonly mask: number }
  | { readonly type: "key"; readonly keysym: number; readonly down: boolean }

/** Byte length of each client message type the fake server understands, given the bytes so far. */
const messageLength = (buffer: Buffer): number | undefined => {
  switch (buffer[0]) {
    case 0:
      return 20
    case 2:
      return buffer.length < 4 ? undefined : 4 + 4 * buffer.readUInt16BE(2)
    case 3:
      return 10
    case 4:
      return 8
    case 5:
      return 6
    case 6:
      return buffer.length < 8 ? undefined : 8 + buffer.readUInt32BE(4)
    default:
      throw new Error(`unknown RFB client message type ${buffer[0]}`)
  }
}

/** Splits complete client messages off `buffer`; returns the input events and the incomplete tail. */
const takeMessages = (buffer: Buffer): { readonly events: Array<RfbEvent>; readonly rest: Buffer } => {
  const events: Array<RfbEvent> = []
  let rest = buffer
  for (;;) {
    if (rest.length === 0) break
    const length = messageLength(rest)
    if (length === undefined || rest.length < length) break
    if (rest[0] === 5)
      events.push({ type: "pointer", mask: rest[1]!, x: rest.readUInt16BE(2), y: rest.readUInt16BE(4) })
    if (rest[0] === 4) events.push({ type: "key", down: rest[1] === 1, keysym: rest.readUInt32BE(4) })
    rest = rest.subarray(length)
  }
  return { events, rest }
}

export const decodeClientMessages = (bytes: Uint8Array): Array<RfbEvent> => {
  const { events, rest } = takeMessages(Buffer.from(bytes))
  if (rest.length > 0) throw new Error(`${rest.length} trailing bytes`)
  return events
}

/** The smallest valid PNG: one transparent pixel. */
export const FAKE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
)

export const SCREENSHOT_SCRIPT = "import -window root png:-"

const decodeExecRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ script: Schema.String, detach: Schema.optional(Schema.Boolean) })),
)

const frame = (type: number, payload: Uint8Array) => {
  const header = Buffer.alloc(5)
  header[0] = type
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

/** Speaks the server half of an RFB 3.8 handshake with a 1280x800 screen, then records input. */
const serveRfb = (socket: Socket, head: Buffer, onEvent: (event: RfbEvent) => void) => {
  let buffer = head
  let stage: "version" | "security" | "init" | "messages" = "version"
  const step = () => {
    for (;;) {
      if (stage === "version" && buffer.length >= 12) {
        buffer = buffer.subarray(12)
        socket.write(Buffer.from([1, 1]))
        stage = "security"
      } else if (stage === "security" && buffer.length >= 1) {
        buffer = buffer.subarray(1)
        socket.write(Buffer.alloc(4))
        stage = "init"
      } else if (stage === "init" && buffer.length >= 1) {
        buffer = buffer.subarray(1)
        const name = Buffer.from("fake")
        const init = Buffer.alloc(24)
        init.writeUInt16BE(1280, 0)
        init.writeUInt16BE(800, 2)
        init.writeUInt32BE(name.length, 20)
        socket.write(Buffer.concat([init, name]))
        stage = "messages"
      } else if (stage === "messages") {
        const { events, rest } = takeMessages(buffer)
        events.forEach(onEvent)
        buffer = rest
        return
      } else return
    }
  }
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    step()
  })
  socket.on("error", () => {})
  // Upgraded sockets are half-open; a VNC server closes its side when the client does.
  socket.on("end", () => socket.end())
  socket.write("RFB 003.008\n")
  step()
}

export interface FakeSbx {
  readonly url: string
  readonly token: string
  /** A `config.json` like the one `sbx login` writes, pointing at this server. */
  readonly configPath: string
  readonly sandboxes: Set<string>
  /** How many sandboxes were ever created. */
  readonly created: () => number
  readonly execs: Array<{ readonly sandboxId: string; readonly script: string; readonly detach: boolean }>
  /** Every input event any VNC connection sent, in arrival order. */
  readonly inputs: Array<{ readonly sandboxId: string; readonly event: RfbEvent }>
  /** Drops a sandbox the way sbx's idle timeout does, so later calls get 404. */
  readonly expire: (id: string) => void
}

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks).toString()))
    request.on("error", reject)
  })

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

/** A real HTTP server that implements the sbxd endpoints kkcode uses. Close it by closing the scope. */
export const startFakeSbx = Effect.acquireRelease(
  Effect.callback<{ readonly fake: FakeSbx; readonly close: () => void }>((resume) => {
    const token = `token-${randomUUID()}`
    const sandboxes = new Set<string>()
    const execs: Array<FakeSbx["execs"][number]> = []
    const inputs: Array<FakeSbx["inputs"][number]> = []
    const sockets = new Set<Socket>()
    let created = 0

    const server = createServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) return json(response, 401, { error: "unauthorized" })
      const path = new URL(request.url ?? "/", "http://fake").pathname
      const body = await readBody(request)
      if (request.method === "GET" && path === "/v1/status") {
        return json(response, 200, { version: "fake", sandboxes: sandboxes.size, max_sandboxes: 64 })
      }
      if (request.method === "POST" && path === "/v1/sandboxes") {
        const id = `sb-${randomUUID().slice(0, 8)}`
        sandboxes.add(id)
        created++
        return json(response, 201, { id, template: "default", cpus: 2, memory_mib: 2048, ttl: "1h0m0s" })
      }
      const match = /^\/v1\/sandboxes\/([^/]+)(\/exec)?$/.exec(path)
      const id = match?.[1]
      if (id === undefined) return json(response, 404, { error: "not found" })
      if (!sandboxes.has(id)) return json(response, 404, { error: `sandbox ${id} not found` })
      if (match?.[2] === undefined && request.method === "GET") return json(response, 200, { id, template: "default" })
      if (match?.[2] === undefined && request.method === "DELETE") {
        sandboxes.delete(id)
        response.writeHead(204).end()
        return
      }
      const exec = decodeExecRequest(body)
      if (Option.isNone(exec)) return json(response, 400, { error: "invalid exec request" })
      const { script, detach = false } = exec.value
      execs.push({ sandboxId: id, script, detach })
      response.writeHead(200, { "content-type": "application/octet-stream" })
      if (detach) {
        response.end(frame(3, Buffer.from(JSON.stringify({ exit_code: 0, pid: 4242, log: "/tmp/sbx-4242.log" }))))
      } else if (script === SCREENSHOT_SCRIPT) {
        response.end(Buffer.concat([frame(1, FAKE_PNG), frame(3, Buffer.from(JSON.stringify({ exit_code: 0 })))]))
      } else {
        response.end(
          Buffer.concat([frame(1, Buffer.from(script)), frame(3, Buffer.from(JSON.stringify({ exit_code: 0 })))]),
        )
      }
    })

    server.on("connection", (socket) => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
    })
    server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = new URL(request.url ?? "/", "http://fake")
      const id = /^\/v1\/sandboxes\/([^/]+)\/tcp$/.exec(url.pathname)?.[1]
      const refuse = (status: string, error: string) => {
        const payload = JSON.stringify({ error })
        socket.end(
          `HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`,
        )
      }
      if (request.headers.authorization !== `Bearer ${token}`) return refuse("401 Unauthorized", "unauthorized")
      if (id === undefined || !sandboxes.has(id)) return refuse("404 Not Found", `sandbox ${id} not found`)
      if (url.searchParams.get("port") !== "5900") return refuse("502 Bad Gateway", "connection refused")
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
      serveRfb(socket, head, (event) => inputs.push({ sandboxId: id, event }))
    })

    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      const configPath = join(mkdtempSync(join(tmpdir(), "kk-sbx-")), "config.json")
      writeFileSync(configPath, JSON.stringify({ url, token }))
      resume(
        Effect.succeed({
          fake: {
            url,
            token,
            configPath,
            sandboxes,
            created: () => created,
            execs,
            inputs,
            expire: (id) => void sandboxes.delete(id),
          },
          close: () => {
            sockets.forEach((socket) => socket.destroy())
            server.close()
          },
        }),
      )
    })
  }),
  ({ close }) => Effect.sync(close),
).pipe(Effect.map(({ fake }) => fake))

export class FakeSbxServer extends Context.Service<FakeSbxServer, FakeSbx>()("test/FakeSbxServer") {}

export const fakeSbxLayer = Layer.effect(FakeSbxServer, startFakeSbx)
