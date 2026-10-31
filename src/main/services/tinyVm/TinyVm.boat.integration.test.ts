import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdtempSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, ManagedRuntime, Scope } from "effect"
import { defaultSettings } from "../../../shared/domain.ts"
import * as Db from "../../db/client.ts"
import * as Boat from "../boat/Boat.ts"
import { Events } from "../Events.ts"
import * as Secrets from "../Secrets.ts"
import * as Settings from "../Settings.ts"
import { TinyVm, layer } from "./TinyVm.ts"

const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])

interface FakeBoat {
  readonly url: string
  readonly created: () => number
  readonly resumes: () => number
  readonly stops: () => number
  readonly commands: ReadonlyArray<string>
  readonly setFailStop: (fail: boolean) => void
  readonly expireNextResume: () => void
}

const readBody = (request: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks)))
  })

const startFakeBoat: Effect.Effect<FakeBoat, never, Scope.Scope> = Effect.gen(function* () {
  const files = new Map<string, Buffer>()
  const commands: Array<string> = []
  const states = new Map<string, string>()
  let created = 0
  let resumes = 0
  let stops = 0
  let failStop = false
  let expiredResume = false
  let base = ""
  const stateOf = (id: string) => states.get(id) ?? "ready"

  const sendJson = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" })
    response.end(JSON.stringify(body))
  }

  const handleCommand = (response: ServerResponse, command: string) => {
    commands.push(command)
    if (command.includes("bash -lc") && command.includes(".hinacode-")) {
      const out = /'(\/tmp\/\.hinacode-[^']+\.out)'/.exec(command)?.[1] ?? ""
      const err = /'(\/tmp\/\.hinacode-[^']+\.err)'/.exec(command)?.[1] ?? ""
      const stdout = command.includes("import -window root")
        ? FAKE_PNG
        : Buffer.from(command.includes("printf hello") ? "hello" : "")
      files.set(out, stdout)
      files.set(err, Buffer.alloc(0))
      const exitCode = command.includes("exit 7") ? 7 : 0
      return sendJson(response, 200, { ok: true, type: "command.finished", success: true, exitCode, timedOut: false })
    }
    const statPath = /^stat -c %s '([^']+)'$/.exec(command)?.[1]
    if (statPath !== undefined) {
      const bytes = files.get(statPath)
      return sendJson(response, 200, {
        ok: true,
        type: "command.finished",
        success: bytes !== undefined,
        exitCode: bytes === undefined ? 1 : 0,
        stdout: bytes === undefined ? "" : `${bytes.length}\n`,
        stderr: "",
        timedOut: false,
      })
    }
    if (command.includes("tar -cf")) {
      const tarPath = /tar -cf '([^']+)'/.exec(command)?.[1] ?? ""
      const tar = files.get("__seeded_tar__") ?? Buffer.alloc(0)
      files.set(tarPath, tar)
      return sendJson(response, 200, {
        ok: true,
        type: "command.finished",
        success: true,
        exitCode: 0,
        stdout: `${tar.length}\n`,
        stderr: "",
        timedOut: false,
      })
    }
    return sendJson(response, 200, {
      ok: true,
      type: "command.finished",
      success: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    })
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", base || "http://127.0.0.1")
      const route = url.pathname
      if (route === "/signed") {
        const path = url.searchParams.get("path") ?? ""
        if (request.method === "PUT") {
          files.set(path, await readBody(request))
          response.writeHead(200)
          return response.end()
        }
        const bytes = files.get(path)
        if (bytes === undefined) {
          response.writeHead(404)
          return response.end()
        }
        response.writeHead(200)
        return response.end(bytes)
      }
      if (request.headers.authorization !== "Bearer test-key") {
        return sendJson(response, 401, {
          ok: false,
          type: "sandbox.error",
          status: 401,
          code: "unauthorized",
          message: "unauthorized",
          error: { code: "unauthorized", message: "unauthorized", status: 401 },
          requestId: "req_test",
        })
      }
      const bodyText = (await readBody(request)).toString()
      const body = bodyText === "" ? {} : (JSON.parse(bodyText) as Record<string, unknown>)
      if (request.method === "POST" && route === "/sandboxes") {
        created += 1
        const id = `bx_fake${String(created).padStart(4, "0")}`
        states.set(id, "ready")
        return sendJson(response, 202, {
          ok: true,
          type: "sandbox.created",
          sandbox: { id, name: String(body["name"] ?? ""), state: "provisioning" },
        })
      }
      if (request.method === "GET" && route === "/sandboxes") {
        return sendJson(response, 200, {
          ok: true,
          type: "sandbox.list",
          sandboxes: [...states.entries()].map(([id, state]) => ({
            id,
            name: "hinacode-vm-test",
            state,
            labels: { hinacode: "1" },
          })),
        })
      }
      if (request.method === "GET" && route === "/limits") {
        return sendJson(response, 200, {
          ok: true,
          type: "limits",
          canStart: true,
          currentLimits: { activeSandboxes: 100 },
        })
      }
      const sandbox = /^\/sandboxes\/([^/]+)(\/.*)?$/.exec(route)
      if (!sandbox) return sendJson(response, 404, { ok: false, type: "sandbox.error", message: "not found" })
      const sandboxId = sandbox[1] ?? ""
      const suffix = sandbox[2] ?? ""
      if (request.method === "GET" && suffix === "") {
        if (!states.has(sandboxId))
          return sendJson(response, 404, {
            ok: false,
            type: "sandbox.error",
            status: 404,
            code: "not_found",
            message: "sandbox not found",
            error: { code: "not_found", message: "sandbox not found", status: 404 },
            requestId: "req_test4040",
          })
        return sendJson(response, 200, {
          ok: true,
          type: "sandbox.info",
          sandbox: { id: sandboxId, name: "hinacode-vm-test", state: stateOf(sandboxId), labels: { hinacode: "1" } },
        })
      }
      if (request.method === "POST" && suffix === "/stop") {
        if (failStop)
          return sendJson(response, 500, {
            ok: false,
            type: "sandbox.error",
            status: 500,
            code: "internal",
            message: "stop exploded",
            error: { code: "internal", message: "stop exploded", status: 500 },
            requestId: "req_test5000",
          })
        stops += 1
        states.set(sandboxId, "archived")
        return sendJson(response, 202, { ok: true, type: "sandbox.stopping", id: sandboxId, status: "archiving" })
      }
      if (request.method === "POST" && suffix === "/resume") {
        if (expiredResume) {
          expiredResume = false
          return sendJson(response, 409, {
            ok: false,
            type: "sandbox.error",
            status: 409,
            code: "snapshot_data_expired",
            message: "snapshot data has expired",
            error: { code: "snapshot_data_expired", message: "snapshot data has expired", status: 409 },
            requestId: "req_test4090",
          })
        }
        resumes += 1
        states.set(sandboxId, "ready")
        return sendJson(response, 202, { ok: true, type: "sandbox.resuming", id: sandboxId, status: "resuming" })
      }
      if (request.method === "POST" && suffix === "/commands")
        return handleCommand(response, String(body["command"] ?? ""))
      if (request.method === "GET" && suffix === "/files") {
        const path = url.searchParams.get("path") ?? ""
        const bytes = files.get(path)
        if (bytes === undefined)
          return sendJson(response, 404, {
            ok: false,
            type: "sandbox.error",
            status: 404,
            code: "not_found",
            message: "file not found",
            error: { code: "not_found", message: "file not found", status: 404 },
            requestId: "req_test4041",
          })
        if (bytes.length > 5 * 1024 * 1024)
          return sendJson(response, 400, {
            ok: false,
            type: "sandbox.error",
            status: 400,
            code: "file_too_large",
            message: "file too large",
            error: { code: "file_too_large", message: "file too large", status: 400 },
            requestId: "req_test4001",
          })
        return sendJson(response, 200, {
          ok: true,
          type: "file.read",
          success: true,
          path,
          encoding: "base64",
          size: bytes.length,
          content: bytes.toString("base64"),
        })
      }
      if (request.method === "PUT" && suffix === "/files") {
        const path = String(body["path"] ?? "")
        const bytes = Buffer.from(String(body["content"] ?? ""), body["encoding"] === "base64" ? "base64" : "utf8")
        files.set(path, bytes)
        return sendJson(response, 200, {
          ok: true,
          type: "file.written",
          success: true,
          path,
          encoding: body["encoding"] === "base64" ? "base64" : "utf8",
          size: bytes.length,
        })
      }
      if (request.method === "POST" && suffix === "/files/download-url") {
        return sendJson(response, 200, {
          ok: true,
          type: "file.download_url",
          url: `${base}/signed?path=${encodeURIComponent(String(body["path"] ?? ""))}`,
          method: "GET",
          path: String(body["path"] ?? ""),
          expiresAt: "2099-01-01T00:00:00Z",
        })
      }
      if (request.method === "POST" && suffix === "/files/upload-url") {
        return sendJson(response, 200, {
          ok: true,
          type: "file.upload_url",
          url: `${base}/signed?path=${encodeURIComponent(String(body["path"] ?? ""))}`,
          method: "PUT",
          path: String(body["path"] ?? ""),
          expiresAt: "2099-01-01T00:00:00Z",
        })
      }
      if (request.method === "POST" && suffix === "/desktop") {
        return sendJson(response, 200, {
          ok: true,
          type: "desktop.url",
          success: true,
          desktopUrl: `${base}/desktop-page#token=sekret`,
        })
      }
      return sendJson(response, 404, {
        ok: false,
        type: "sandbox.error",
        message: `unhandled ${request.method} ${route}`,
      })
    })()
  })

  yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", () => {
            const address = server.address()
            base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`
            resolve()
          })
        }),
    ),
    () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  )

  files.set("__seeded_tar__", Buffer.from("seeded-tar"))
  return {
    url: base,
    created: () => created,
    resumes: () => resumes,
    stops: () => stops,
    commands,
    setFailStop: (fail) => {
      failStop = fail
    },
    expireNextResume: () => {
      expiredResume = true
    },
  }
})

const makeRuntime = (fake: FakeBoat, dir: string) =>
  ManagedRuntime.make(
    Layer.unwrap(
      Effect.gen(function* () {
        const settings = yield* Settings.Settings
        yield* settings.set({
          experimental: { ...defaultSettings.experimental, tinyVm: true, tinyVmProvider: "boat" },
        })
        const boat = Boat.layer({ BOAT_API_KEY: "test-key", BOAT_API_BASE: fake.url }).pipe(
          Layer.provide(Secrets.layer),
        )
        return layer({ configPath: join(dir, "no-sbx-login.json"), env: {} }, dir).pipe(Layer.provide(boat))
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Settings.layer(mkdtempSync(join(tmpdir(), "hinacode-boat-vm-settings-"))),
          Layer.succeed(Events, { publish: () => Effect.void }),
          Secrets.noKeyring,
        ).pipe(Layer.provideMerge(Db.layer(":memory:")), Layer.provide(NodeServices.layer)),
      ),
    ),
  )

it.effect("a boat VM starts, runs, clicks, stops into a snapshot and resumes on the next start", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* startFakeBoat
      const dir = mkdtempSync(join(tmpdir(), "hinacode-boat-vm-"))
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() => makeRuntime(fake, dir)),
        (value) => Effect.promise(() => value.dispose()),
      )
      const run = <A, E>(effect: Effect.Effect<A, E, TinyVm>) => Effect.promise(() => runtime.runPromise(effect))

      const host = yield* run(TinyVm.use((vm) => vm.host))
      expect(host).toMatchObject({ status: "connected", provider: "boat", sandboxes: 0, maxSandboxes: 100 })

      const started = yield* run(TinyVm.use((vm) => vm.start("thread-1")))
      expect(started).toMatchObject({
        status: "running",
        provider: "boat",
        sandboxId: "bx_fake0001",
        template: "default",
        profile: "off",
        control: "agent",
      })
      expect(fake.created()).toBe(1)
      expect(fake.commands.some((command) => command.includes("apt-get"))).toBe(true)
      expect(JSON.parse(yield* Effect.promise(() => readFile(join(dir, "boat-sandboxes.json"), "utf8")))).toEqual({
        "thread-1": "bx_fake0001",
      })

      const exec = yield* run(
        TinyVm.use((vm) => vm.exec("thread-1", { command: "printf hello", timeoutSeconds: 30, background: false })),
      )
      expect(exec.exitCode).toBe(0)
      expect(Buffer.from(exec.stdout).toString()).toBe("hello")

      const shot = yield* run(TinyVm.use((vm) => vm.screenshot("thread-1")))
      expect(Buffer.from(shot)).toEqual(FAKE_PNG)

      yield* run(TinyVm.use((vm) => vm.act("thread-1", [{ type: "click", x: 10, y: 20, button: "left", clicks: 1 }])))
      expect(fake.commands.some((command) => command.includes("xdotool mousemove 10 20"))).toBe(true)

      const url = yield* run(TinyVm.use((vm) => vm.desktopUrl("thread-1")))
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/desktop\/[0-9a-f-]{36}$/)
      expect(url).not.toContain("sekret")
      const redirect = yield* Effect.promise(() => fetch(url, { redirect: "manual" }))
      expect(redirect.status).toBe(302)
      expect(redirect.headers.get("location")).toContain("overlay=0")
      expect(redirect.headers.get("location")?.endsWith("#token=sekret")).toBe(true)
      const replay = yield* Effect.promise(() => fetch(url, { redirect: "manual" }))
      expect(replay.status).toBe(404)

      const tunnelError = yield* run(
        TinyVm.use((vm) => vm.openTunnel("thread-1", 9222)).pipe(
          Effect.match({ onFailure: (error) => error.message, onSuccess: () => "" }),
        ),
      )
      expect(tunnelError).toContain("boat VM")

      yield* run(TinyVm.use((vm) => vm.stop("thread-1")))
      expect(fake.stops()).toBe(1)
      expect(yield* run(TinyVm.use((vm) => vm.get("thread-1")))).toEqual({ status: "none" })

      const resumed = yield* run(TinyVm.use((vm) => vm.start("thread-1")))
      expect(resumed).toMatchObject({ status: "running", provider: "boat", sandboxId: "bx_fake0001" })
      expect(fake.created()).toBe(1)
      expect(fake.resumes()).toBe(1)
    }),
  ),
)

it.effect("concurrent starts keep every mapping, a failed stop keeps the VM, an expired snapshot is replaced", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* startFakeBoat
      const dir = mkdtempSync(join(tmpdir(), "hinacode-boat-vm-race-"))
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() => makeRuntime(fake, dir)),
        (value) => Effect.promise(() => value.dispose()),
      )
      const run = <A, E>(effect: Effect.Effect<A, E, TinyVm>) => Effect.promise(() => runtime.runPromise(effect))

      const [first, second] = yield* Effect.promise(() =>
        Promise.all([
          runtime.runPromise(TinyVm.use((vm) => vm.start("thread-1"))),
          runtime.runPromise(TinyVm.use((vm) => vm.start("thread-2"))),
        ]),
      )
      expect(first).toMatchObject({ status: "running" })
      expect(second).toMatchObject({ status: "running" })
      const firstId = first.status === "running" ? first.sandboxId : ""
      const secondId = second.status === "running" ? second.sandboxId : ""
      expect(new Set([firstId, secondId])).toEqual(new Set(["bx_fake0001", "bx_fake0002"]))
      const map = JSON.parse(yield* Effect.promise(() => readFile(join(dir, "boat-sandboxes.json"), "utf8"))) as Record<
        string,
        string
      >
      expect(map).toEqual({ "thread-1": firstId, "thread-2": secondId })

      fake.setFailStop(true)
      yield* run(TinyVm.use((vm) => vm.stop("thread-1")))
      expect(yield* run(TinyVm.use((vm) => vm.get("thread-1")))).toMatchObject({ status: "running" })
      fake.setFailStop(false)
      yield* run(TinyVm.use((vm) => vm.stop("thread-1")))
      expect(yield* run(TinyVm.use((vm) => vm.get("thread-1")))).toEqual({ status: "none" })

      fake.expireNextResume()
      const replaced = yield* run(TinyVm.use((vm) => vm.start("thread-1")))
      expect(replaced).toMatchObject({ status: "running", sandboxId: "bx_fake0003" })
      expect(fake.created()).toBe(3)
      const nextMap = JSON.parse(
        yield* Effect.promise(() => readFile(join(dir, "boat-sandboxes.json"), "utf8")),
      ) as Record<string, string>
      expect(nextMap["thread-1"]).toBe("bx_fake0003")
    }),
  ),
)
