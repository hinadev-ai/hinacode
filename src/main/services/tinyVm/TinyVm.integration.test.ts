import { existsSync, mkdtempSync } from "node:fs"
import { readFile, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import type { PushEvent } from "../../../shared/contract.ts"
import { defaultSettings, type ExperimentalSettings, Thread } from "../../../shared/domain.ts"
import * as Db from "../../db/client.ts"
import { Events, makeEventsLayer } from "../Events.ts"
import * as Settings from "../Settings.ts"
import { encodeTar } from "./tar.ts"
import { type FakeSbx, startFakeSbx } from "./testing.ts"
import { MAX_TRANSFER_BYTES, TinyVm, layer } from "./TinyVm.ts"

const makeRuntime = (fake: FakeSbx, profileDir: string, experimental: Partial<ExperimentalSettings> = {}) =>
  ManagedRuntime.make(
    Layer.unwrap(
      Effect.gen(function* () {
        const settings = yield* Settings.Settings
        yield* settings.set({
          experimental: {
            ...defaultSettings.experimental,
            tinyVm: true,
            tinyVmProvider: "sbx",
            tinyVmProfile: true,
            ...experimental,
          },
        })
        return layer({ configPath: fake.configPath, env: {} }, profileDir)
      }),
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Settings.layer(mkdtempSync(join(tmpdir(), "hinacode-vm-settings-"))),
          makeEventsLayer(() => {}),
        ).pipe(Layer.provide(Db.layer(":memory:")), Layer.provide(NodeServices.layer)),
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

it.effect("quitting destroys the profile owner's VM even while its profile save stalls", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* startFakeSbx
      const dir = mkdtempSync(join(tmpdir(), "hinacode-vm-profile-"))
      const runtime = makeRuntime(fake, dir)
      const owner = yield* Effect.promise(() => runtime.runPromise(TinyVm.use((vm) => vm.start("owner"))))
      expect(owner).toMatchObject({ status: "running", profile: "owner" })
      fake.stallExecs("tar -czf")

      yield* Effect.promise(() => runtime.dispose())

      expect(fake.sandboxes.size).toBe(0)
    }),
  ),
)

it.effect("saving the profile of a VM the host destroyed forgets the VM", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* startFakeSbx
      const dir = mkdtempSync(join(tmpdir(), "hinacode-vm-profile-"))
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() => makeRuntime(fake, dir)),
        (value) => Effect.promise(() => value.dispose()),
      )
      const run = <A, E>(effect: Effect.Effect<A, E, TinyVm>) => Effect.promise(() => runtime.runPromise(effect))
      const owner = yield* run(TinyVm.use((vm) => vm.start("owner")))
      if (owner.status !== "running") throw new Error("VM did not start")
      fake.expire(owner.sandboxId)

      const error = yield* run(Effect.flip(TinyVm.use((vm) => vm.saveProfile("owner"))))

      expect(error._tag).toBe("VmError")
      expect(yield* run(TinyVm.use((vm) => vm.get("owner")))).toEqual({ status: "none" })
    }),
  ),
)

it.effect("dropping files past the transfer limit names the limit, not what is left of it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* startFakeSbx
      const dir = mkdtempSync(join(tmpdir(), "hinacode-vm-profile-"))
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() => makeRuntime(fake, dir, { tinyVmProfile: false })),
        (value) => Effect.promise(() => value.dispose()),
      )
      const host = mkdtempSync(join(tmpdir(), "hinacode-vm-drop-"))
      yield* Effect.promise(() => writeFile(join(host, "small.bin"), Buffer.alloc(1024 * 1024)))
      yield* Effect.promise(() => writeFile(join(host, "huge.bin"), ""))
      yield* Effect.promise(() => truncate(join(host, "huge.bin"), MAX_TRANSFER_BYTES))

      const error = yield* Effect.promise(() =>
        runtime.runPromise(
          Effect.flip(TinyVm.use((vm) => vm.dropFiles("thread", [join(host, "small.bin"), join(host, "huge.bin")]))),
        ),
      )

      expect(error.message).toContain(`${MAX_TRANSFER_BYTES / 1024 / 1024} MB`)
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

it.effect("a new VM gets the configured environment and runs the setup script before it is running", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* startFakeSbx
      const dir = mkdtempSync(join(tmpdir(), "hinacode-vm-profile-"))
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeRuntime(fake, dir, {
            tinyVmProfile: false,
            tinyVmEnv: { NODE_ENV: "development" },
            tinyVmSetupScript: "sudo apt-get install -y jq",
          }),
        ),
        (value) => Effect.promise(() => value.dispose()),
      )
      const vm = yield* Effect.promise(() => runtime.runPromise(TinyVm.use((tinyVm) => tinyVm.start("thread"))))

      expect(vm).toMatchObject({ status: "running" })
      expect(fake.createdEnvs).toEqual([{ NODE_ENV: "development" }])
      expect(fake.execs.map((exec) => exec.script)).toEqual(["sudo apt-get install -y jq"])
    }),
  ),
)

it.effect("a failing setup script fails the start and destroys the sandbox", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* startFakeSbx
      const dir = mkdtempSync(join(tmpdir(), "hinacode-vm-profile-"))
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() => makeRuntime(fake, dir, { tinyVmSetupScript: "exit 3" })),
        (value) => Effect.promise(() => value.dispose()),
      )
      const vm = yield* Effect.promise(() => runtime.runPromise(TinyVm.use((tinyVm) => tinyVm.start("thread"))))

      expect(vm).toEqual({ status: "failed", message: "The setup script exited with code 3.\nexit 3" })
      expect(fake.created()).toBe(1)
      expect(fake.sandboxes.size).toBe(0)
    }),
  ),
)

const archivedThread = (id: string) =>
  Schema.decodeUnknownSync(Thread)({
    id,
    projectId: "project",
    worktreeId: null,
    title: "archived",
    provider: "claude",
    model: "sonnet",
    effort: null,
    fastMode: false,
    accessMode: "supervised",
    accountId: null,
    providerSessionId: null,
    status: "archived",
    usageLimit: null,
    sortIndex: 0,
    pinnedAt: null,
    queue: [],
    createdBy: "user",
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
  })

for (const [name, event] of [
  ["deleting", { type: "thread.removed", id: "thread" }],
  ["archiving", { type: "thread.updated", thread: archivedThread("thread") }],
] as const satisfies ReadonlyArray<readonly [string, PushEvent]>) {
  it.effect(`${name} a thread stops its VM and deletes the files it pulled`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* startFakeSbx
        const dir = mkdtempSync(join(tmpdir(), "hinacode-vm-profile-"))
        const runtime = yield* Effect.acquireRelease(
          Effect.sync(() => makeRuntime(fake, dir, { tinyVmProfile: false })),
          (value) => Effect.promise(() => value.dispose()),
        )
        const vm = yield* Effect.promise(() => runtime.runPromise(TinyVm.use((tinyVm) => tinyVm.start("thread"))))
        if (vm.status !== "running") throw new Error("VM did not start")
        fake.seedFile(
          vm.sandboxId,
          "/tmp/report.txt",
          encodeTar([{ type: "file", path: "report.txt", data: Buffer.from("report"), mode: 0o644, mtime: 0 }]),
        )
        const pulled = yield* Effect.promise(() =>
          runtime.runPromise(TinyVm.use((tinyVm) => tinyVm.pullFiles("thread", "/tmp/report.txt"))),
        )
        expect(existsSync(pulled.path)).toBe(true)

        yield* Effect.promise(() => runtime.runPromise(Events.use((events) => events.publish(event))))
        yield* Effect.promise(() => fake.whenRemoved(vm.sandboxId))

        expect(yield* Effect.promise(() => runtime.runPromise(TinyVm.use((tinyVm) => tinyVm.get("thread"))))).toEqual({
          status: "none",
        })
        expect(existsSync(join(dir, "pulled", "thread"))).toBe(false)
      }),
    ),
  )
}
