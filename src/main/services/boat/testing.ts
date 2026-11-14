import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo, Socket } from "node:net"

export const API_KEY = "test-key"

export const BINARY_STDOUT = Buffer.from([0x89, 0x00, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x68, 0x69])
export const BIG_STDOUT = Buffer.alloc(5 * 1024 * 1024 + 7, 7)
export const TAR_BYTES = Buffer.from("fake-tar-bytes-for-get-files-round-trip-0123456789")

interface FakeSandboxRecord {
  id: string
  name: string
  state: string
  getCount: number
  labels: Record<string, string>
}

export interface FakeBoat {
  readonly baseUrl: string
  readonly origin: string
  readonly createBodies: Array<Record<string, unknown>>
  readonly createIdempotencyKeys: Array<string | undefined>
  readonly commands: Array<string>
  readonly requests: Array<string>
  readonly files: Map<string, Buffer>
  readonly deletedConfirmHeaders: Array<string | undefined>
  readonly stopped: Array<string>
  readonly resumed: Array<Record<string, unknown>>
  readonly hostBodies: Array<Record<string, unknown>>
  readonly setMachineOutput: (output: {
    readonly stdout: string
    readonly stderr: string
    readonly exitCode: number
  }) => void
  readonly desktopCalls: () => number
  readonly dropSignedFetches: (count: number) => void
  readonly failFileReads: (count: number) => void
  readonly seedSandbox: (id: string, state: string, labels?: Record<string, string>) => void
  readonly lastCreatedId: () => string | undefined
  readonly close: () => Promise<void>
}

const readRequestBody = (request: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks)))
    request.on("error", reject)
  })

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

const errorEnvelope = (status: number, code: string, message: string, requestId: string) => ({
  ok: false,
  type: "sandbox.error",
  status,
  code,
  message,
  error: { code, message, status },
  requestId,
})

const parseJsonBody = (body: Buffer): Record<string, unknown> => {
  if (body.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(body.toString())
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export const startFakeBoat = (): Promise<FakeBoat> =>
  new Promise((resolve) => {
    const sandboxes = new Map<string, FakeSandboxRecord>()
    const files = new Map<string, Buffer>()
    const createBodies: Array<Record<string, unknown>> = []
    const createIdempotencyKeys: Array<string | undefined> = []
    const commands: Array<string> = []
    const requests: Array<string> = []
    const deletedConfirmHeaders: Array<string | undefined> = []
    const stopped: Array<string> = []
    const resumed: Array<Record<string, unknown>> = []
    const hostBodies: Array<Record<string, unknown>> = []
    let machineOutput = { stdout: "", stderr: "", exitCode: 0 }
    const sockets = new Set<Socket>()
    let desktopCallCount = 0
    let signedDrops = 0
    let failedFileReads = 0
    let createdCount = 0
    let origin = ""

    const handleCommand = (sandboxId: string, body: Record<string, unknown>, response: ServerResponse) => {
      const command = typeof body["command"] === "string" ? body["command"] : ""
      commands.push(command)
      if (body["detached"] === true) {
        if (command.includes("empty-detached")) return sendJson(response, 200, {})
        return sendJson(response, 200, { success: true, pid: 4321, logPath: "/tmp/detached.log" })
      }
      const reportSizes = () => {
        const sizes = [/'(\/tmp\/\.hinacode-[^']+\.out)'/, /'(\/tmp\/\.hinacode-[^']+\.err)'/].map((pattern) => {
          const path = pattern.exec(command)?.[1] ?? ""
          const size = files.get(path)?.length ?? 0
          if (size === 0) files.delete(path)
          return size
        })
        return `hinacode-output-sizes ${sizes.join(" ")}\n`
      }
      if (command.startsWith("o=$(stat ")) {
        return sendJson(response, 200, {
          success: true,
          exitCode: 0,
          timedOut: false,
          stdout: reportSizes(),
          stderr: "",
        })
      }
      if (command.includes("bash -lc ") && command.includes(".hinacode-")) {
        const outMatch = /'(\/tmp\/\.hinacode-[^']+\.out)'/.exec(command)
        const errMatch = /'(\/tmp\/\.hinacode-[^']+\.err)'/.exec(command)
        if (command.includes("hinacode pair")) {
          if (outMatch?.[1]) files.set(outMatch[1], Buffer.from(machineOutput.stdout))
          if (errMatch?.[1]) files.set(errMatch[1], Buffer.from(machineOutput.stderr))
          const { exitCode } = machineOutput
          return sendJson(response, 200, {
            success: exitCode === 0,
            exitCode,
            timedOut: false,
            stdout: reportSizes(),
            stderr: "",
          })
        }
        const quiet = command.includes("quiet")
        const stdout = command.includes("big-stdout") ? BIG_STDOUT : quiet ? Buffer.alloc(0) : BINARY_STDOUT
        const stderr = quiet || command.includes("stdout-only") ? Buffer.alloc(0) : Buffer.from("warn\n")
        if (outMatch?.[1]) files.set(outMatch[1], stdout)
        if (errMatch?.[1]) files.set(errMatch[1], stderr)
        if (command.includes("time-out"))
          return sendJson(response, 200, { success: false, exitCode: null, timedOut: true, stdout: "", stderr: "" })
        const exitCode = command.includes("exit 3") ? 3 : 0
        return sendJson(response, 200, {
          success: exitCode === 0,
          exitCode,
          timedOut: false,
          stdout: reportSizes(),
          stderr: "",
        })
      }
      if (command.includes("tar -cf ") && command.includes("stat -c%s")) {
        const tarMatch = /tar -cf '([^']+)'/.exec(command)
        if (tarMatch?.[1]) files.set(tarMatch[1], TAR_BYTES)
        return sendJson(response, 200, {
          success: true,
          exitCode: 0,
          timedOut: false,
          stdout: `${TAR_BYTES.length}\n`,
          stderr: "",
        })
      }
      if (command.includes("tar -xf")) {
        return sendJson(response, 200, { success: true, exitCode: 0, timedOut: false, stdout: "", stderr: "" })
      }
      if (command.startsWith("rm -f ")) {
        const paths = [...command.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? "")
        paths.forEach((path) => files.delete(path))
        return sendJson(response, 200, { success: true, exitCode: 0, timedOut: false, stdout: "", stderr: "" })
      }
      void sandboxId
      return sendJson(response, 200, { success: true, exitCode: 0, timedOut: false, stdout: "ok", stderr: "" })
    }

    const server = createServer(async (request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://fake")
      const pathname = requestUrl.pathname
      const body = await readRequestBody(request)
      requests.push(
        `${request.method} ${pathname.startsWith("/signed/") ? "/signed" : pathname.replace(/^\/api\/v1/, "").replace(/^\/sandboxes\/[^/?]+/, "/sandboxes/{id}")}`,
      )

      if (pathname.startsWith("/signed/")) {
        if (signedDrops > 0) {
          signedDrops -= 1
          request.socket.destroy()
          return
        }
        const guestPath = decodeURIComponent(pathname.slice("/signed/".length))
        if (request.method === "PUT") {
          files.set(guestPath, body)
          response.writeHead(200).end()
          return
        }
        if (request.method === "GET") {
          const bytes = files.get(guestPath)
          if (bytes === undefined) {
            response.writeHead(404).end("missing")
            return
          }
          response.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes)
          return
        }
        response.writeHead(405).end()
        return
      }

      if (request.headers.authorization !== `Bearer ${API_KEY}`) {
        return sendJson(response, 401, errorEnvelope(401, "unauthorized", "unauthorized", "req-401"))
      }

      const route = pathname.replace(/^\/api\/v1/, "")
      const jsonBody = parseJsonBody(body)

      if (request.method === "GET" && route === "/limits") {
        return sendJson(response, 200, {
          ok: true,
          type: "limits",
          canStart: true,
          currentLimits: { activeSandboxes: 100 },
        })
      }

      if (request.method === "GET" && route === "/environments") {
        return sendJson(response, 200, {
          ok: true,
          environments: [
            { id: "env-1", name: "base", isDefault: true, envContents: "SECRET=1" },
            { id: "env-2", name: "demo", isDefault: false },
          ],
        })
      }

      if (request.method === "GET" && route === "/saved-snapshots") {
        return sendJson(response, 200, {
          ok: true,
          snapshots: [
            { name: "tpl", status: "ready", sourceSandboxId: "sb-0", createdAt: "2026-11-07T00:00:00Z" },
            { name: "wip", status: "saving", sourceSandboxId: "sb-0", createdAt: "2026-11-07T00:00:00Z" },
          ],
        })
      }

      if (request.method === "POST" && route === "/sandboxes") {
        createdCount += 1
        const id = `sb-created-${createdCount}`
        createBodies.push(jsonBody)
        const header = request.headers["idempotency-key"]
        createIdempotencyKeys.push(Array.isArray(header) ? header[0] : header)
        const labels = (jsonBody["labels"] ?? {}) as Record<string, string>
        sandboxes.set(id, { id, name: "created", state: "provisioning", getCount: 0, labels })
        return sendJson(response, 202, {
          ok: true,
          type: "sandbox.created",
          sandbox: { id, name: "created", state: "provisioning" },
        })
      }

      if (request.method === "GET" && route === "/sandboxes") {
        const all = [...sandboxes.values()]
        const cursor = Number(requestUrl.searchParams.get("cursor") ?? "0")
        const page = all.slice(cursor, cursor + 2)
        const hasMore = cursor + 2 < all.length
        return sendJson(response, 200, {
          ok: true,
          type: "sandbox.list",
          sandboxes: page.map(({ id, name, state, labels }) => ({
            id,
            name,
            state,
            labels,
            type: "small",
            subdomain: id,
          })),
          pageInfo: { hasMore, nextCursor: hasMore ? String(cursor + 2) : null },
        })
      }

      const sandboxMatch = /^\/sandboxes\/([^/]+)(\/.*)?$/.exec(route)
      const sandboxId = sandboxMatch?.[1] !== undefined ? decodeURIComponent(sandboxMatch[1]) : undefined
      const suffix = sandboxMatch?.[2] ?? ""
      if (sandboxId === undefined) {
        return sendJson(response, 404, errorEnvelope(404, "not_found", "route not found", "req-route-404"))
      }
      const record = sandboxes.get(sandboxId)
      if (record === undefined) {
        return sendJson(response, 404, errorEnvelope(404, "not_found", `sandbox ${sandboxId} not found`, "req-404"))
      }

      if (suffix === "" && request.method === "GET") {
        if (record.state === "secret")
          return sendJson(
            response,
            400,
            errorEnvelope(400, "bad_request", "key boat_leaked12345 see https://x.example/d#token=leaked", "req_leak"),
          )
        record.getCount += 1
        if (record.state === "provisioning" && record.getCount >= 2) record.state = "ready"
        return sendJson(response, 200, {
          ok: true,
          type: "sandbox",
          sandbox: { id: record.id, name: record.name, state: record.state },
        })
      }

      if (suffix === "" && request.method === "DELETE") {
        const header = request.headers["x-ascii-confirm-delete"]
        deletedConfirmHeaders.push(Array.isArray(header) ? header[0] : header)
        sandboxes.delete(sandboxId)
        return sendJson(response, 200, { ok: true, type: "sandbox.deleted" })
      }

      if (suffix === "/stop" && request.method === "POST") {
        stopped.push(sandboxId)
        record.state = "archived"
        return sendJson(response, 200, {
          ok: true,
          type: "sandbox.stopped",
          sandbox: { id: record.id, state: record.state },
        })
      }

      if (suffix === "/resume" && request.method === "POST") {
        resumed.push(jsonBody)
        record.state = "provisioning"
        record.getCount = 0
        return sendJson(response, 200, {
          ok: true,
          type: "sandbox.resuming",
          sandbox: { id: record.id, state: record.state },
        })
      }

      if (suffix === "/commands" && request.method === "POST") return handleCommand(sandboxId, jsonBody, response)

      if (suffix === "/files" && request.method === "GET") {
        if (failedFileReads > 0) {
          failedFileReads -= 1
          return sendJson(response, 503, errorEnvelope(503, "unavailable", "try later", "req-file-503"))
        }
        const guestPath = requestUrl.searchParams.get("path") ?? ""
        const bytes = files.get(guestPath)
        if (bytes === undefined)
          return sendJson(response, 404, errorEnvelope(404, "not_found", "file not found", "req-file-404"))
        if (bytes.length > 5 * 1024 * 1024)
          return sendJson(response, 400, errorEnvelope(400, "file_too_large", "file too large", "req-file-big"))
        return sendJson(response, 200, {
          ok: true,
          type: "file.read",
          success: true,
          path: guestPath,
          encoding: "base64",
          size: bytes.length,
          content: bytes.toString("base64"),
        })
      }

      if (suffix === "/files" && request.method === "PUT") {
        const guestPath = typeof jsonBody["path"] === "string" ? jsonBody["path"] : ""
        const content = typeof jsonBody["content"] === "string" ? jsonBody["content"] : ""
        const bytes = jsonBody["encoding"] === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8")
        files.set(guestPath, bytes)
        return sendJson(response, 200, {
          ok: true,
          type: "file.written",
          success: true,
          path: guestPath,
          encoding: jsonBody["encoding"] === "base64" ? "base64" : "utf8",
          size: bytes.length,
        })
      }

      if (suffix === "/files/download-url" && request.method === "POST") {
        const guestPath = typeof jsonBody["path"] === "string" ? jsonBody["path"] : ""
        return sendJson(response, 200, { ok: true, url: `${origin}/signed/${encodeURIComponent(guestPath)}` })
      }

      if (suffix === "/files/upload-url" && request.method === "POST") {
        const guestPath = typeof jsonBody["path"] === "string" ? jsonBody["path"] : ""
        return sendJson(response, 200, {
          ok: true,
          url: `${origin}/signed/${encodeURIComponent(guestPath)}`,
          method: "PUT",
        })
      }

      if (suffix === "/desktop" && request.method === "POST") {
        desktopCallCount += 1
        if (desktopCallCount === 1) {
          return sendJson(response, 200, { ok: true, type: "desktop", provisioning: true, desktopUrl: null })
        }
        return sendJson(response, 200, {
          ok: true,
          type: "desktop",
          provisioning: false,
          desktopUrl: "https://desktop.boat.dev/sb-test?foo=1#token=secret",
        })
      }

      if (suffix === "/host" && request.method === "POST") {
        hostBodies.push(jsonBody)
        const port = typeof jsonBody["port"] === "number" ? jsonBody["port"] : 0
        return sendJson(response, 200, { ok: true, url: `https://${sandboxId}-${port}.boat.dev` })
      }

      return sendJson(response, 404, errorEnvelope(404, "not_found", "route not found", "req-route-404"))
    })

    server.on("connection", (socket) => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
    })

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port
      origin = `http://127.0.0.1:${port}`
      resolve({
        baseUrl: `${origin}/api/v1`,
        origin,
        createBodies,
        createIdempotencyKeys,
        commands,
        requests,
        files,
        deletedConfirmHeaders,
        stopped,
        resumed,
        hostBodies,
        setMachineOutput: (output) => {
          machineOutput = output
        },
        desktopCalls: () => desktopCallCount,
        dropSignedFetches: (count) => {
          signedDrops = count
        },
        lastCreatedId: () => (createdCount === 0 ? undefined : `sb-created-${createdCount}`),
        failFileReads: (count) => {
          failedFileReads = count
        },
        seedSandbox: (id, state, labels = {}) =>
          void sandboxes.set(id, { id, name: "seeded", state, getCount: 99, labels }),
        close: () =>
          new Promise<void>((done) => {
            sockets.forEach((socket) => socket.destroy())
            server.close(() => done())
          }),
      })
    })
  })

export const withFake = async (run: (fake: FakeBoat) => Promise<void>) => {
  const fake = await startFakeBoat()
  try {
    await run(fake)
  } finally {
    await fake.close()
  }
}
