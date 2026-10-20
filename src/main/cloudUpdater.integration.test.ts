import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Layer } from "effect"
import { layer } from "./cloudUpdater.ts"
import { Events } from "./services/Events.ts"
import { Updates } from "./services/Updates.ts"

const noEvents = Layer.succeed(Events, { publish: () => Effect.void })

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

/** A global npm prefix with `hinacode` installed at `version`. */
const globalInstall = (version: string) => {
  const prefix = mkdtempSync(join(tmpdir(), "hinacode-prefix-"))
  const packageRoot = join(prefix, "lib", "node_modules", "hinacode")
  mkdirSync(packageRoot, { recursive: true })
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "hinacode", version }))
  return { prefix, packageRoot }
}

const packRelease = (version: string) => {
  const source = mkdtempSync(join(tmpdir(), "hinacode-release-"))
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "hinacode", version }))
  execFileSync("npm", ["pack", "--pack-destination", source], { cwd: source, stdio: "ignore" })
  return join(
    source,
    readdirSync(source).find((file) => file.endsWith(".tgz"))!,
  )
}

const statusAfterCheck = Effect.gen(function* () {
  const updates = yield* Updates
  yield* updates.check
  return yield* updates.status
})

describe("cloud updater", () => {
  it.effect("does not update a package outside a global npm install", () =>
    Effect.gen(function* () {
      const registry = yield* startRegistry({ version: "0.2.0" })
      const packageRoot = mkdtempSync(join(tmpdir(), "hinacode-checkout-"))
      const status = yield* statusAfterCheck.pipe(
        Effect.provide(layer({ current: "0.1.0", packageRoot, registry, restart: () => {} })),
      )
      expect(status).toEqual({ current: "0.1.0", state: { type: "unsupported" } })
    }).pipe(Effect.provide(noEvents), Effect.scoped),
  )

  it.effect("is up to date when latest is the running version", () =>
    Effect.gen(function* () {
      const registry = yield* startRegistry({ version: "0.1.0" })
      const { packageRoot } = globalInstall("0.1.0")
      const status = yield* statusAfterCheck.pipe(
        Effect.provide(layer({ current: "0.1.0", packageRoot, registry, restart: () => {} })),
      )
      expect(status.state).toEqual({ type: "upToDate" })
    }).pipe(Effect.provide(noEvents), Effect.scoped),
  )

  it.effect("reports a failed check with the registry's status", () =>
    Effect.gen(function* () {
      const registry = yield* startRegistry(null)
      const { packageRoot } = globalInstall("0.1.0")
      const status = yield* statusAfterCheck.pipe(
        Effect.provide(layer({ current: "0.1.0", packageRoot, registry, restart: () => {} })),
      )
      expect(status.state.type).toBe("failed")
    }).pipe(Effect.provide(noEvents), Effect.scoped),
  )

  it.effect("installs latest into its own prefix, then restarts", () =>
    Effect.gen(function* () {
      process.env["npm_config_cache"] = mkdtempSync(join(tmpdir(), "hinacode-npm-cache-"))
      const registry = yield* startRegistry({ version: "0.2.0", tarball: packRelease("0.2.0") })
      const { prefix, packageRoot } = globalInstall("0.1.0")
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
          }),
        ),
      )
      const installed = JSON.parse(
        readFileSync(join(prefix, "lib", "node_modules", "hinacode", "package.json"), "utf8"),
      )
      expect(installed.version).toBe("0.2.0")
    }).pipe(Effect.provide(noEvents), Effect.scoped),
  )
})
