import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { Effect, Layer, Option, Redacted } from "effect"
import { describe, expect, it } from "vitest"
import { Secrets } from "../Secrets.ts"
import { Boat, boatClient, layer as boatLayer } from "./Boat.ts"

const API_KEY = "test-key"

const BINARY_STDOUT = Buffer.from([0x89, 0x00, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x68, 0x69])
const TAR_BYTES = Buffer.from("fake-tar-bytes-for-get-files-round-trip-0123456789")

interface FakeSandboxRecord {
  id: string
  name: string
  state: string
  getCount: number
}

interface FakeBoat {
  readonly baseUrl: string
  readonly origin: string
  readonly createBodies: Array<Record<string, unknown>>
  readonly createIdempotencyKeys: Array<string | undefined>
  readonly commands: Array<string>
  readonly files: Map<string, Buffer>
  readonly deletedConfirmHeaders: Array<string | undefined>
  readonly stopped: Array<string>
  readonly resumed: Array<Record<string, unknown>>
  readonly desktopCalls: () => number
  readonly dropSignedFetches: (count: number) => void
  readonly seedSandbox: (id: string, state: string) => void
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

const startFakeBoat = (): Promise<FakeBoat> =>
  new Promise((resolve) => {
    const sandboxes = new Map<string, FakeSandboxRecord>()
    const files = new Map<string, Buffer>()
    const createBodies: Array<Record<string, unknown>> = []
    const createIdempotencyKeys: Array<string | undefined> = []
    const commands: Array<string> = []
    const deletedConfirmHeaders: Array<string | undefined> = []
    const stopped: Array<string> = []
    const resumed: Array<Record<string, unknown>> = []
    const sockets = new Set<Socket>()
    let desktopCallCount = 0
    let signedDrops = 0
    let createdCount = 0
    let origin = ""

    const handleCommand = (sandboxId: string, body: Record<string, unknown>, response: ServerResponse) => {
      const command = typeof body["command"] === "string" ? body["command"] : ""
      commands.push(command)
      if (body["detached"] === true) {
        if (command.includes("empty-detached")) return sendJson(response, 200, {})
        return sendJson(response, 200, { success: true, pid: 4321, logPath: "/tmp/detached.log" })
      }
      if (command.includes("bash -lc ") && command.includes(".hinacode-")) {
        const outMatch = /'(\/tmp\/\.hinacode-[^']+\.out)'/.exec(command)
        const errMatch = /'(\/tmp\/\.hinacode-[^']+\.err)'/.exec(command)
        if (outMatch?.[1]) files.set(outMatch[1], BINARY_STDOUT)
        if (errMatch?.[1]) files.set(errMatch[1], Buffer.from("warn\n"))
        const exitCode = command.includes("exit 3") ? 3 : 0
        return sendJson(response, 200, { success: exitCode === 0, exitCode, timedOut: false, stdout: "", stderr: "" })
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
      const statMatch = /^stat -c %s '([^']+)'$/.exec(command)
      if (statMatch?.[1]) {
        const bytes = files.get(statMatch[1])
        return bytes === undefined
          ? sendJson(response, 200, { success: false, exitCode: 1, timedOut: false, stdout: "", stderr: "no file" })
          : sendJson(response, 200, {
              success: true,
              exitCode: 0,
              timedOut: false,
              stdout: `${bytes.length}\n`,
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

      if (request.method === "POST" && route === "/sandboxes") {
        createdCount += 1
        const id = `sb-created-${createdCount}`
        createBodies.push(jsonBody)
        const header = request.headers["idempotency-key"]
        createIdempotencyKeys.push(Array.isArray(header) ? header[0] : header)
        sandboxes.set(id, { id, name: "created", state: "provisioning", getCount: 0 })
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
          sandboxes: page.map(({ id, name, state }) => ({ id, name, state })),
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
        if (record.state === "expired")
          return sendJson(
            response,
            409,
            errorEnvelope(409, "snapshot_data_expired", "snapshot data has expired", "req_expired1"),
          )
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
        files,
        deletedConfirmHeaders,
        stopped,
        resumed,
        desktopCalls: () => desktopCallCount,
        dropSignedFetches: (count) => {
          signedDrops = count
        },
        seedSandbox: (id, state) => void sandboxes.set(id, { id, name: "seeded", state, getCount: 99 }),
        close: () =>
          new Promise<void>((done) => {
            sockets.forEach((socket) => socket.destroy())
            server.close(() => done())
          }),
      })
    })
  })

const withFake = async (run: (fake: FakeBoat) => Promise<void>) => {
  const fake = await startFakeBoat()
  try {
    await run(fake)
  } finally {
    await fake.close()
  }
}

const makeClient = (fake: FakeBoat, apiKey = API_KEY) =>
  boatClient({ baseUrl: fake.baseUrl, apiKey: Redacted.make(apiKey) })

const runEffect = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const runFlip = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect))

describe("boatClient", () => {
  it("rejects a wrong key without echoing it", async () => {
    await withFake(async (fake) => {
      const wrongKey = "wrong-secret-key-value"
      const client = makeClient(fake, wrongKey)
      const error = await runFlip(client.limits())
      expect(error._tag).toBe("BoatError")
      expect(error.message).toContain("boat rejected the API key")
      expect(error.message).toContain("Settings > Experimental")
      expect(error.message).not.toContain(wrongKey)
    })
  })

  it("never echoes upstream error text that could carry secrets", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-secret", "secret")
      const client = makeClient(fake)
      const error = await runFlip(client.getSandbox("sb-secret"))
      expect(error._tag).toBe("BoatError")
      expect(error.message).toContain("request failed (HTTP 400")
      expect(error.message).not.toContain("boat_leaked12345")
      expect(error.message).not.toContain("token=leaked")
      expect(error.message).not.toContain("req_leak")
    })
  })

  it("follows list pagination", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-a", "ready")
      fake.seedSandbox("sb-b", "ready")
      fake.seedSandbox("sb-c", "archived")
      const client = makeClient(fake)
      const all = await runEffect(client.listAll())
      expect(all.map((sandbox) => sandbox.id)).toEqual(["sb-a", "sb-b", "sb-c"])
    })
  })

  it("fails a detached exec that answers without a process id", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-1", "ready")
      const client = makeClient(fake)
      const error = await runFlip(client.exec("sb-1", { script: "empty-detached", timeoutSeconds: 30, detach: true }))
      expect(error._tag).toBe("BoatError")
      expect(error.message).toContain("without a process id")
    })
  })

  it("tags an expired snapshot on resume", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-old", "expired")
      const client = makeClient(fake)
      const error = await runFlip(client.resume("sb-old"))
      expect(error._tag).toBe("BoatSnapshotExpiredError")
    })
  })

  it("create sends ttl, labels and an idempotency key and waits for ready", async () => {
    await withFake(async (fake) => {
      const client = makeClient(fake)
      const created = await runEffect(client.create("large", { FOO: "bar" }))
      expect(created.id).toBe("sb-created-1")
      expect(fake.createBodies).toHaveLength(1)
      expect(fake.createBodies[0]).toMatchObject({
        type: "large",
        ttlSeconds: 7200,
        env: { FOO: "bar" },
        labels: { hinacode: "1" },
      })
      expect(fake.createIdempotencyKeys[0]).toBeTruthy()
      expect(typeof fake.createIdempotencyKeys[0]).toBe("string")
      const sandbox = await runEffect(client.getSandbox(created.id))
      expect(sandbox.state).toBe("ready")
    })
  }, 15000)

  it("create falls back to the default size for an unknown template", async () => {
    await withFake(async (fake) => {
      const client = makeClient(fake)
      await runEffect(client.create("unknown-template"))
      expect(fake.createBodies[0]).toMatchObject({ type: "default" })
    })
  }, 15000)

  it("exec returns exact binary stdout bytes and the exit code", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-1", "ready")
      const client = makeClient(fake)
      const result = await runEffect(client.exec("sb-1", { script: "cat /tmp/pic.png; exit 3", timeoutSeconds: 30 }))
      expect(Buffer.from(result.stdout)).toEqual(BINARY_STDOUT)
      expect(Buffer.from(result.stderr).toString()).toBe("warn\n")
      expect(result.exitCode).toBe(3)
      expect(fake.commands.some((command) => command.startsWith("DISPLAY=:0 bash -lc "))).toBe(true)
      expect(fake.commands.some((command) => command.startsWith("rm -f "))).toBe(true)
    })
  })

  it("exec works while the guest-served signed URLs never answer", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-1", "ready")
      fake.dropSignedFetches(100)
      const client = makeClient(fake)
      const result = await runEffect(client.exec("sb-1", { script: "cat /tmp/pic.png", timeoutSeconds: 30 }))
      expect(Buffer.from(result.stdout)).toEqual(BINARY_STDOUT)
      expect(Buffer.from(result.stderr).toString()).toBe("warn\n")
    })
  })

  it("putFiles works while the guest-served signed URLs never answer", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-1", "ready")
      fake.dropSignedFetches(100)
      const client = makeClient(fake)
      const tar = Buffer.from("tar-contents")
      await runEffect(client.putFiles("sb-1", "Downloads", tar))
      const uploaded = [...fake.files.values()].find((bytes) => bytes.equals(tar))
      expect(uploaded).toBeDefined()
    })
  })

  it("retries a dropped signed download for a file over the direct limit", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-1", "ready")
      const big = Buffer.alloc(5 * 1024 * 1024 + 7, 7)
      fake.files.set("/tmp/big.bin", big)
      fake.dropSignedFetches(1)
      const client = makeClient(fake)
      const bytes = await runEffect(client.readFileBytes("sb-1", "/tmp/big.bin"))
      expect(Buffer.from(bytes)).toEqual(big)
    })
  }, 60000)

  it("detached exec returns pid and log", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-1", "ready")
      const client = makeClient(fake)
      const result = await runEffect(client.exec("sb-1", { script: "sleep 100", timeoutSeconds: 30, detach: true }))
      expect(result.pid).toBe(4321)
      expect(result.log).toBe("/tmp/detached.log")
      expect(result.exitCode).toBe(0)
      expect(result.stdout.length).toBe(0)
    })
  })

  it("putFiles uploads then extracts into /home/user/Downloads for a relative path", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-1", "ready")
      const client = makeClient(fake)
      const tar = Buffer.from("tar-contents")
      await runEffect(client.putFiles("sb-1", "Downloads", tar))
      const uploadedTarPaths = [...fake.files.keys()].filter(
        (path) => path.includes(".hinacode-") && path.endsWith(".tar"),
      )
      expect(uploadedTarPaths.length).toBeGreaterThanOrEqual(1)
      const uploaded = uploadedTarPaths.map((path) => fake.files.get(path)).find((bytes) => bytes?.equals(tar))
      expect(uploaded).toBeDefined()
      expect(
        fake.commands.some((command) => command.includes("tar -xf") && command.includes("'/home/user/Downloads'")),
      ).toBe(true)
      expect(fake.commands.some((command) => command.includes("mkdir -p '/home/user/Downloads'"))).toBe(true)
    })
  })

  it("getFiles returns tar bytes and refuses over the cap", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-1", "ready")
      const client = makeClient(fake)
      const bytes = await runEffect(client.getFiles("sb-1", "Downloads/report.txt"))
      expect(Buffer.from(bytes)).toEqual(TAR_BYTES)
      expect(
        fake.commands.some((command) => command.includes("tar -cf") && command.includes("'/home/user/Downloads'")),
      ).toBe(true)
      const error = await runFlip(client.getFiles("sb-1", "Downloads/report.txt", 10))
      expect(error._tag).toBe("BoatError")
      expect(error.message).toContain("the archive is larger than")
    })
  })

  it("desktopUrl polls past provisioning and adds overlay=0 before the fragment", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-1", "ready")
      const client = makeClient(fake)
      const url = await runEffect(client.desktopUrl("sb-1"))
      expect(fake.desktopCalls()).toBe(2)
      expect(url).toBe("https://desktop.boat.dev/sb-test?foo=1&overlay=0#token=secret")
    })
  }, 15000)

  it("a 404 get becomes SandboxGoneError", async () => {
    await withFake(async (fake) => {
      const client = makeClient(fake)
      const error = await runFlip(client.get("sb-missing"))
      expect(error._tag).toBe("SandboxGoneError")
    })
  })

  it("stop, resume and remove call the right routes", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-1", "ready")
      const client = makeClient(fake)
      await runEffect(client.stop("sb-1"))
      expect(fake.stopped).toEqual(["sb-1"])
      const resumed = await runEffect(client.resume("sb-1"))
      expect(resumed.id).toBe("sb-1")
      expect(fake.resumed).toEqual([{ ttlSeconds: 7200 }])
      await runEffect(client.remove("sb-1"))
      expect(fake.deletedConfirmHeaders).toEqual(["sb-1"])
      await runEffect(client.remove("sb-1"))
    })
  }, 15000)

  it("limits, status, templates, hostPort and listAll have the expected shapes", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-1", "ready")
      fake.seedSandbox("sb-2", "provisioning")
      fake.seedSandbox("sb-3", "archived")
      const client = makeClient(fake)
      expect(client.url).toBe(fake.baseUrl)
      expect(await runEffect(client.limits())).toEqual({ canStart: true, maxSandboxes: 100 })
      expect(await runEffect(client.status)).toEqual({ sandboxes: 2, maxSandboxes: 100 })
      expect(await runEffect(client.templates)).toEqual([
        { name: "small", cpus: 2, memoryMiB: 4096 },
        { name: "default", cpus: 4, memoryMiB: 8192 },
        { name: "large", cpus: 8, memoryMiB: 16384 },
        { name: "xlarge", cpus: 16, memoryMiB: 32768 },
      ])
      expect(await runEffect(client.hostPort("sb-1", 8080))).toBe("https://sb-1-8080.boat.dev")
      const all = await runEffect(client.listAll())
      expect(all.map((sandbox) => sandbox.id).toSorted()).toEqual(["sb-1", "sb-2", "sb-3"])
      fake.files.set("/home/user/note.txt", Buffer.from("hello-bytes"))
      const downloaded = await runEffect(client.readFileBytes("sb-1", "/home/user/note.txt"))
      expect(Buffer.from(downloaded).toString()).toBe("hello-bytes")
    })
  })
})

describe("Boat service", () => {
  const emptySecretsLayer = Layer.succeed(
    Secrets,
    Secrets.of({
      get: () => Effect.succeed(Option.none()),
      has: () => Effect.succeed(false),
      set: () => Effect.void,
      clear: () => Effect.void,
    }),
  )

  it("fails with BoatNotConfiguredError when neither env nor secret has a key", async () => {
    const program = Effect.gen(function* () {
      const boat = yield* Boat
      const configured = yield* boat.configured
      const error = yield* Effect.flip(boat.client)
      return { configured, error }
    })
    const result = await Effect.runPromise(Effect.provide(program, Layer.provide(boatLayer({}), emptySecretsLayer)))
    expect(result.configured).toBe(false)
    expect(result.error._tag).toBe("BoatNotConfiguredError")
    expect(result.error.message).toContain("BOAT_API_KEY")
  })

  it("env key wins and configured reports presence only", async () => {
    const program = Effect.gen(function* () {
      const boat = yield* Boat
      const configured = yield* boat.configured
      const client = yield* boat.client
      return { configured, url: client.url }
    })
    const result = await Effect.runPromise(
      Effect.provide(
        program,
        Layer.provide(
          boatLayer({ BOAT_API_KEY: "env-key", BOAT_API_BASE: "http://127.0.0.1:9/api/v1/" }),
          emptySecretsLayer,
        ),
      ),
    )
    expect(result.configured).toBe(true)
    expect(result.url).toBe("http://127.0.0.1:9/api/v1")
  })

  it("reads the key from Secrets when the env has none", async () => {
    const storedSecretsLayer = Layer.succeed(
      Secrets,
      Secrets.of({
        get: (name) => Effect.succeed(name === "boat.apiKey" ? Option.some("stored-key") : Option.none()),
        has: () => Effect.succeed(true),
        set: () => Effect.void,
        clear: () => Effect.void,
      }),
    )
    const program = Effect.gen(function* () {
      const boat = yield* Boat
      const configured = yield* boat.configured
      const client = yield* boat.client
      return { configured, url: client.url }
    })
    const result = await Effect.runPromise(Effect.provide(program, Layer.provide(boatLayer({}), storedSecretsLayer)))
    expect(result.configured).toBe(true)
    expect(result.url).toBe("https://boat.dev/api/v1")
  })
})
