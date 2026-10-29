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
  let state = "ready"
  let created = 0
  let resumes = 0
  let stops = 0
  let base = ""

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
        state = "ready"
        return sendJson(response, 202, {
          ok: true,
          type: "sandbox.created",
          sandbox: { id: "bx_fake0001", name: String(body["name"] ?? ""), state: "provisioning" },
        })
      }
      if (request.method === "GET" && route === "/sandboxes") {
        return sendJson(response, 200, {
          ok: true,
          type: "sandbox.list",
          sandboxes: [{ id: "bx_fake0001", name: "hinacode-vm-test", state, labels: { hinacode: "1" } }],
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
      const suffix = sandbox[2] ?? ""
      if (request.method === "GET" && suffix === "") {
        return sendJson(response, 200, {
          ok: true,
          type: "sandbox.info",
          sandbox: { id: "bx_fake0001", name: "hinacode-vm-test", state, labels: { hinacode: "1" } },
        })
      }
      if (request.method === "POST" && suffix === "/stop") {
        stops += 1
        state = "archived"
        return sendJson(response, 202, { ok: true, type: "sandbox.stopping", id: "bx_fake0001", status: "archiving" })
      }
      if (request.method === "POST" && suffix === "/resume") {
        resumes += 1
        state = "ready"
        return sendJson(response, 202, { ok: true, type: "sandbox.resuming", id: "bx_fake0001", status: "resuming" })
      }
      if (request.method === "POST" && suffix === "/commands")
        return handleCommand(response, String(body["command"] ?? ""))
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
      expect(host).toMatchObject({ status: "connected", provider: "boat", sandboxes: 1, maxSandboxes: 100 })

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
      expect(url).toContain("overlay=0")
      expect(url.endsWith("#token=sekret")).toBe(true)

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
