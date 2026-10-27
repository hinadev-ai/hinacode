import { once } from "node:events"
import { mkdtempSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, ManagedRuntime } from "effect"
import * as Db from "../../db/client.ts"
import { Events } from "../Events.ts"
import * as Settings from "../Settings.ts"
import { encodeTar } from "./tar.ts"
import { type FakeSbx, startFakeSbx } from "./testing.ts"
import { TinyVm, layer } from "./TinyVm.ts"

const makeRuntime = (fake: FakeSbx, profileDir: string) =>
  ManagedRuntime.make(
    Layer.unwrap(
      Effect.gen(function* () {
        const settings = yield* Settings.Settings
        yield* settings.set({
          experimental: { tinyVm: true, tinyVmTemplate: "default", tinyVmProfile: true, tinyVmPasskeys: false, devices: false },
        })
        return layer({ configPath: fake.configPath, env: {} }, profileDir)
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(Settings.layer, Layer.succeed(Events, { publish: () => Effect.void })).pipe(
          Layer.provide(Db.layer(":memory:")),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  )

const seedProfile = (fake: FakeSbx, sandboxId: string, bytes: Uint8Array) =>
  fake.seedFile(
    sandboxId,
    "/tmp/hinacode-chromium-profile.tgz",
    encodeTar([{ type: "file", path: "hinacode-chromium-profile.tgz", data: bytes, mode: 0o600, mtime: 0 }]),
  )

it.effect("shutdown saves the owner's latest browser profile before destroying every VM", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* startFakeSbx
      const dir = mkdtempSync(join(tmpdir(), "hinacode-vm-profile-"))
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() => makeRuntime(fake, dir)),
        (value) => Effect.promise(() => value.dispose()),
      )
      const owner = yield* Effect.promise(() => runtime.runPromise(TinyVm.use((vm) => vm.start("owner"))))
      const copy = yield* Effect.promise(() => runtime.runPromise(TinyVm.use((vm) => vm.start("copy"))))
      expect(owner).toMatchObject({ status: "running", profile: "owner" })
      expect(copy).toMatchObject({ status: "running", profile: "copy" })
      if (owner.status !== "running" || copy.status !== "running") throw new Error("VM did not start")
      seedProfile(fake, owner.sandboxId, Buffer.from("owner-session"))
      seedProfile(fake, copy.sandboxId, Buffer.from("copy-session"))

      yield* Effect.promise(() => runtime.dispose())

      expect(yield* Effect.promise(() => readFile(join(dir, "chromium-profile.tgz"), "utf8"))).toBe("owner-session")
      expect(fake.sandboxes.size).toBe(0)
    }),
  ),
)

it.effect("overlapping profile saves all finish without racing the archive file", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* startFakeSbx
      const dir = mkdtempSync(join(tmpdir(), "hinacode-vm-profile-"))
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() => makeRuntime(fake, dir)),
        (value) => Effect.promise(() => value.dispose()),
      )
      const owner = yield* Effect.promise(() => runtime.runPromise(TinyVm.use((vm) => vm.start("owner"))))
      if (owner.status !== "running") throw new Error("VM did not start")
      const profile = Buffer.alloc(256 * 1024, 42)
      seedProfile(fake, owner.sandboxId, profile)

      const results = yield* Effect.promise(() =>
        Promise.allSettled(
          Array.from({ length: 20 }, () => runtime.runPromise(TinyVm.use((vm) => vm.saveProfile("owner")))),
        ),
      )

      expect(results.every((result) => result.status === "fulfilled")).toBe(true)
      expect(yield* Effect.promise(() => readFile(join(dir, "chromium-profile.tgz")))).toEqual(profile)
    }),
  ),
)

it.effect("stageArchive uploads one archive to the guest path and openTunnel reaches a guest port", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* startFakeSbx
      const dir = mkdtempSync(join(tmpdir(), "hinacode-vm-profile-"))
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() => makeRuntime(fake, dir)),
        (value) => Effect.promise(() => value.dispose()),
      )
      const archive = encodeTar([
        { type: "file", path: "passkey-extension/manifest.json", data: Buffer.from("{}"), mode: 0o644, mtime: 0 },
      ])
      yield* Effect.promise(() =>
        runtime.runPromise(TinyVm.use((vm) => vm.stageArchive("owner", ".hinacode", archive))),
      )
      expect(fake.uploads).toHaveLength(1)
      expect(fake.uploads[0]).toMatchObject({ path: ".hinacode" })
      expect(fake.uploads[0]?.bytes).toEqual(Buffer.from(archive))

      const tunnel = yield* Effect.promise(() => runtime.runPromise(TinyVm.use((vm) => vm.openTunnel("owner", 5900))))
      const greeting =
        tunnel.head.length > 0
          ? Buffer.from(tunnel.head)
          : (yield* Effect.promise(() => once(tunnel.socket, "data")))[0]
      expect(String(greeting)).toContain("RFB")
      tunnel.socket.destroy()
    }),
  ),
)
