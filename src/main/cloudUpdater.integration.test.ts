import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Queue } from "effect"
import { TestClock } from "effect/testing"
import { isIdle, layer } from "./cloudUpdater.ts"
import { Events } from "./services/Events.ts"
import { Terminals } from "./services/Terminals.ts"
import { Threads } from "./services/Threads.ts"
import { Updates } from "./services/Updates.ts"
import { Worktrees } from "./services/Worktrees.ts"

/** Every state change of the updater, so a test can wait for one instead of sleeping. */
type Changes = Queue.Queue<void>

const events = (changes?: Changes) =>
  Layer.succeed(Events, { publish: () => (changes === undefined ? Effect.void : Queue.offer(changes, undefined)) })

/** The cloud's work in progress as the updater sees it. Mutable, so a test can let a busy cloud go idle. */
const cloud = (
  busy: { running: boolean },
  terminals: ReadonlyArray<{ status: "running" | "exited" }> = [],
  changes?: Changes,
) =>
  Layer.mergeAll(
    events(changes),
    Layer.mock(Threads, {
      list: Effect.sync(() => [{ id: "t1", status: busy.running ? "running" : "idle", queue: [] }] as never),
    }),
    Layer.mock(Worktrees, { list: Effect.succeed([]) }),
    Layer.mock(Terminals, { list: () => Effect.succeed(terminals as never) }),
  )
const idleCloud = cloud({ running: false })

/** A registry that serves one `hinacode` release, or fails every request when `release` is null. */
const startRegistry = (release: { version: string; tarball?: string } | null) =>
  Effect.acquireRelease(
    Effect.callback<{ server: Server; url: string }>((resume) => {
      const server = createServer((request, response) => {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        if (release === null) return void response.writeHead(500).end()
        const manifest = {
          name: "hinacode",
          version: release.version,
          dist: { tarball: `${url}/hinacode/-/hinacode-${release.version}.tgz` },
        }
        if (request.url === "/hinacode/latest") return void response.end(JSON.stringify(manifest))
        if (request.url === "/hinacode") {
          return void response.end(
            JSON.stringify({
              name: "hinacode",
              "dist-tags": { latest: release.version },
              versions: { [release.version]: manifest },
            }),
          )
        }
        if (request.url?.endsWith(".tgz") && release.tarball) return void response.end(readFileSync(release.tarball))
        response.writeHead(404).end()
      })
      server.listen(0, "127.0.0.1", () =>
        resume(Effect.succeed({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })),
      )
    }),
    ({ server }) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  ).pipe(Effect.map(({ url }) => url))

/** A temp directory removed when the test's scope closes, even when the test fails. */
const tempDir = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), prefix))),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )

/** Gives npm a throwaway cache for the scope, then puts back whatever the worker had before. */
const npmCache = Effect.gen(function* () {
  const dir = yield* tempDir("hinacode-npm-cache-")
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env["npm_config_cache"]
      process.env["npm_config_cache"] = dir
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env["npm_config_cache"]
        else process.env["npm_config_cache"] = previous
      }),
  )
})

/** A global npm prefix with `hinacode` installed at `version`. */
const globalInstall = (version: string) =>
  Effect.map(tempDir("hinacode-prefix-"), (prefix) => {
    const packageRoot = join(prefix, "lib", "node_modules", "hinacode")
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "hinacode", version }))
    return { prefix, packageRoot }
  })

const packRelease = (version: string) =>
  Effect.map(tempDir("hinacode-release-"), (source) => {
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "hinacode", version }))
    execFileSync("npm", ["pack", "--pack-destination", source], { cwd: source, stdio: "ignore" })
    return join(
      source,
      readdirSync(source).find((file) => file.endsWith(".tgz"))!,
    )
  })

/** Waits for the check the cloud runs at boot to settle, one published state change at a time. */
const bootChecked = (changes: Changes) =>
  Effect.gen(function* () {
    const updates = yield* Updates
    while (["idle", "checking"].includes((yield* updates.status).state.type)) yield* Queue.take(changes)
  })

const statusAfterCheck = Effect.gen(function* () {
  const updates = yield* Updates
  yield* updates.check
  return yield* updates.status
})

describe("cloud updater", () => {
  it.effect("does not update a package outside a global npm install", () =>
    Effect.gen(function* () {
      const registry = yield* startRegistry({ version: "0.2.0" })
      const packageRoot = yield* tempDir("hinacode-checkout-")
      const status = yield* statusAfterCheck.pipe(
        Effect.provide(layer({ current: "0.1.0", packageRoot, registry, restart: () => {}, autoInstall: false })),
      )
      expect(status).toEqual({ current: "0.1.0", state: { type: "unsupported" } })
    }).pipe(Effect.provide(idleCloud), Effect.scoped),
  )

  it.effect("is up to date when latest is the running version", () =>
    Effect.gen(function* () {
      const registry = yield* startRegistry({ version: "0.1.0" })
      const { packageRoot } = yield* globalInstall("0.1.0")
      const status = yield* statusAfterCheck.pipe(
        Effect.provide(layer({ current: "0.1.0", packageRoot, registry, restart: () => {}, autoInstall: false })),
      )
      expect(status.state).toEqual({ type: "upToDate" })
    }).pipe(Effect.provide(idleCloud), Effect.scoped),
  )

  it.effect("reports a failed check with the registry's status", () =>
    Effect.gen(function* () {
      const registry = yield* startRegistry(null)
      const { packageRoot } = yield* globalInstall("0.1.0")
      const status = yield* statusAfterCheck.pipe(
        Effect.provide(layer({ current: "0.1.0", packageRoot, registry, restart: () => {}, autoInstall: false })),
      )
      expect(status.state.type).toBe("failed")
    }).pipe(Effect.provide(idleCloud), Effect.scoped),
  )

  it.effect("installs latest into its own prefix, then restarts", () =>
    Effect.gen(function* () {
      yield* npmCache
      const registry = yield* startRegistry({ version: "0.2.0", tarball: yield* packRelease("0.2.0") })
      const { prefix, packageRoot } = yield* globalInstall("0.1.0")
      const restarted = yield* Deferred.make<void>()
      yield* Effect.gen(function* () {
        const updates = yield* Updates
        yield* updates.check
        expect((yield* updates.status).state).toEqual({ type: "ready", version: "0.2.0" })
        yield* updates.install
        expect((yield* updates.status).state).toEqual({ type: "downloading", version: "0.2.0" })
        yield* Deferred.await(restarted)
      }).pipe(
        Effect.provide(
          layer({
            current: "0.1.0",
            packageRoot,
            registry,
            restart: () => Deferred.doneUnsafe(restarted, Effect.void),
            autoInstall: false,
          }),
        ),
      )
      const installed = JSON.parse(
        readFileSync(join(prefix, "lib", "node_modules", "hinacode", "package.json"), "utf8"),
      )
      expect(installed.version).toBe("0.2.0")
    }).pipe(Effect.provide(idleCloud), Effect.scoped),
  )

  it.effect("installs on its own only once the cloud goes idle", () =>
    Effect.gen(function* () {
      yield* npmCache
      const registry = yield* startRegistry({ version: "0.2.0", tarball: yield* packRelease("0.2.0") })
      const { packageRoot } = yield* globalInstall("0.1.0")
      const busy = { running: true }
      const changes = yield* Queue.unbounded<void>()
      const restarted = yield* Deferred.make<void>()
      yield* Effect.gen(function* () {
        const updates = yield* Updates
        yield* bootChecked(changes)
        yield* TestClock.adjust("5 minutes")
        expect((yield* updates.status).state).toEqual({ type: "ready", version: "0.2.0" })
        busy.running = false
        yield* TestClock.adjust("1 minute")
        expect((yield* updates.status).state).toEqual({ type: "downloading", version: "0.2.0" })
        yield* Deferred.await(restarted)
      }).pipe(
        Effect.provide(
          layer({
            current: "0.1.0",
            packageRoot,
            registry,
            restart: () => Deferred.doneUnsafe(restarted, Effect.void),
            autoInstall: true,
          }),
        ),
        Effect.provide(cloud(busy, [], changes)),
      )
    }).pipe(Effect.scoped),
  )

  it.effect("installs on its own when its only terminal has exited", () =>
    Effect.gen(function* () {
      yield* npmCache
      const registry = yield* startRegistry({ version: "0.2.0", tarball: yield* packRelease("0.2.0") })
      const { packageRoot } = yield* globalInstall("0.1.0")
      const changes = yield* Queue.unbounded<void>()
      const restarted = yield* Deferred.make<void>()
      yield* Effect.gen(function* () {
        const updates = yield* Updates
        yield* bootChecked(changes)
        yield* TestClock.adjust("1 minute")
        expect((yield* updates.status).state).toEqual({ type: "downloading", version: "0.2.0" })
        yield* Deferred.await(restarted)
      }).pipe(
        Effect.provide(
          layer({
            current: "0.1.0",
            packageRoot,
            registry,
            restart: () => Deferred.doneUnsafe(restarted, Effect.void),
            autoInstall: true,
          }),
        ),
        Effect.provide(cloud({ running: false }, [{ status: "exited" }], changes)),
      )
    }).pipe(Effect.scoped),
  )
})

describe("isIdle", () => {
  const thread = { status: "idle", queue: [] } as const
  it.each([
    ["a running turn", { threads: [{ ...thread, status: "running" as const }], worktrees: [], terminals: [] }],
    [
      "a turn awaiting approval",
      { threads: [{ ...thread, status: "awaiting_approval" as const }], worktrees: [], terminals: [] },
    ],
    ["a queued message", { threads: [{ ...thread, queue: [{}] as never }], worktrees: [], terminals: [] }],
    ["a setup script", { threads: [thread], worktrees: [{ status: "preparing" as const }], terminals: [] }],
    ["a running terminal", { threads: [thread], worktrees: [], terminals: [{ status: "running" as const }] }],
  ])("is busy with %s", (_, state) => expect(isIdle(state)).toBe(false))

  it("is idle with nothing in progress", () =>
    expect(isIdle({ threads: [thread], worktrees: [{ status: "ready" }], terminals: [{ status: "exited" }] })).toBe(
      true,
    ))
})
