import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Db from "../../db/client.ts"
import { type PushEvent, RpcMethods } from "../../../shared/contract.ts"
import type { BoatMachineCreate, Environment, Thread } from "../../../shared/domain.ts"
import { parsePairingUrl } from "../../../shared/remote.ts"
import { type CloudHooks, Environments, type ForwardedCall } from "../Environments.ts"
import * as Secrets from "../Secrets.ts"
import { layer as boatLayer } from "./Boat.ts"
import { BoatMachines, layer as boatMachinesLayer } from "./BoatMachines.ts"
import { API_KEY, type FakeBoat, withFake } from "./testing.ts"

const PAIR_OUTPUT = [
  "HinaCode cloud 0.3.0",
  "Pair a desktop: Settings > Connections > Add environment, with one of:",
  "  hinacode://connect?host=127.0.0.1&port=48081&token=cloud-token",
  "",
].join("\n")

const create: BoatMachineCreate = {
  name: "agents",
  type: "small",
  from: "",
  environment: "base",
  autoStopHours: 2,
  noEnv: false,
  snapshots: true,
  monitoring: true,
  setupScript: "",
}

const CLOUD_ID = "cloud-1"

interface FakeCloud {
  readonly added: Array<{ name: string; pairingUrl: string }>
  readonly forwarded: Array<ForwardedCall>
  readonly reconnected: Array<string>
  hooks: CloudHooks | null
  threads: ReadonlyArray<Partial<Thread>>
}

const threadOf = (fields: Partial<Thread>) => ({
  id: "thread-1",
  projectId: "project-1",
  worktreeId: null,
  title: "t",
  provider: "claude",
  model: "claude-sonnet-5-5",
  effort: null,
  fastMode: false,
  accessMode: "full",
  accountId: null,
  providerSessionId: null,
  status: "idle",
  usageLimit: null,
  sortIndex: 0,
  pinnedAt: null,
  queue: [],
  createdBy: "user",
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
  ...fields,
})

const fakeEnvironments = (fake: FakeBoat, cloud: FakeCloud) =>
  Layer.succeed(
    Environments,
    Environments.of({
      add: (input: { readonly name: string; readonly pairingUrl: string }) => {
        cloud.added.push(input)
        return Effect.succeed({ id: CLOUD_ID, name: input.name } as Environment)
      },
      list: Effect.sync(() => ({
        clouds: [{ id: CLOUD_ID, host: `${fake.lastCreatedId() ?? "sb-thread"}-48081.boat.dev` }],
      })),
      forward: (_id: string, call: ForwardedCall) => {
        cloud.forwarded.push(call)
        if (call.method === "threads.list") return Effect.succeed({ result: cloud.threads.map(threadOf) })
        return Effect.succeed({
          result: {
            id: "project-2",
            name: "app",
            rootPath: "/home/user/app",
            setupScript: "pnpm i",
            createdAt: "2026-11-07T00:00:00.000Z",
            updatedAt: "2026-11-07T00:00:00.000Z",
            environmentId: CLOUD_ID,
          },
        })
      },
      reconnect: (id: string) => Effect.sync(() => void cloud.reconnected.push(id)),
      hook: (hooks: CloudHooks) =>
        Effect.sync(() => {
          cloud.hooks = hooks
        }),
    } as unknown as typeof Environments.Service),
  )

const runMachines = <A, E>(
  fake: FakeBoat,
  use: (machines: typeof BoatMachines.Service, cloud: FakeCloud) => Effect.Effect<A, E>,
  env: Readonly<Record<string, string>> = { BOAT_API_KEY: API_KEY, BOAT_API_BASE: fake.baseUrl },
  machinesEnv: Readonly<Record<string, string>> = {},
) => {
  const cloud: FakeCloud = { added: [], forwarded: [], reconnected: [], hooks: null, threads: [] }
  const layer = boatMachinesLayer(machinesEnv).pipe(
    Layer.provide(Layer.mergeAll(fakeEnvironments(fake, cloud), boatLayer(env))),
    Layer.provide(Secrets.layer),
    Layer.provide(Db.layer(":memory:")),
    Layer.provide(Layer.mergeAll(NodeServices.layer, Secrets.noKeyring)),
  )
  return Effect.runPromise(BoatMachines.use((machines) => use(machines, cloud)).pipe(Effect.provide(layer))).then(
    (result) => ({ result, added: cloud.added, cloud }),
  )
}

const settledPush = (fields: Partial<Thread>) =>
  ({ type: "thread.updated", thread: threadOf(fields) }) as unknown as PushEvent

describe("BoatMachines", () => {
  it("asks for a key before listing anything", async () => {
    await withFake(async (fake) => {
      const { result } = await runMachines(fake, (machines) => machines.options, {})
      expect(result).toEqual({ configured: false })
    })
  })

  it("lists live sandboxes, environments and ready snapshots", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-live", "ready")
      fake.seedSandbox("sb-gone", "cancelled")
      const { result } = await runMachines(fake, (machines) => machines.options)
      expect(result).toEqual({
        configured: true,
        sandboxes: [{ id: "sb-live", name: "seeded", state: "ready", type: "small" }],
        environments: [
          { name: "base", isDefault: true },
          { name: "demo", isDefault: false },
        ],
        snapshots: ["tpl"],
      })
    })
  })

  it("creates a sandbox, starts HinaCode in it and pairs through its public URL", async () => {
    await withFake(async (fake) => {
      fake.setMachineOutput({ stdout: PAIR_OUTPUT, stderr: "", exitCode: 0 })
      const { added } = await runMachines(fake, (machines) => machines.connect({ sandbox: { create } }))
      expect(fake.createBodies[0]).toMatchObject({
        type: "small",
        ttlSeconds: 7200,
        name: "agents",
        environment: "base",
        labels: { hinacode: "machine" },
      })
      expect(fake.commands.some((command) => command.includes("hinacode pair"))).toBe(true)
      expect(fake.hostBodies).toEqual([{ port: 48081, public: true, localhost: true }])
      expect(added).toHaveLength(1)
      expect(parsePairingUrl(added[0]!.pairingUrl)).toEqual({
        hosts: ["sb-created-1-48081.boat.dev"],
        port: 443,
        token: "cloud-token",
        relay: "sb-created-1-48081.boat.dev",
      })
    })
  })

  it("installs the package HINACODE_BOAT_PACKAGE names instead of the npm release", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-live", "ready")
      fake.setMachineOutput({ stdout: PAIR_OUTPUT, stderr: "", exitCode: 0 })
      const tarball = join(mkdtempSync(join(tmpdir(), "hinacode-dev-package-")), "hinacode.tgz")
      writeFileSync(tarball, "dev-package-bytes")
      await runMachines(fake, (machines) => machines.connect({ sandbox: { id: "sb-live" } }), undefined, {
        HINACODE_BOAT_PACKAGE: tarball,
      })
      expect(fake.files.get("/tmp/hinacode-dev.tgz")?.toString()).toBe("dev-package-bytes")
      const script = fake.commands.find((command) => command.includes("hinacode pair")) ?? ""
      expect(script).toContain("npm install -g /tmp/hinacode-dev.tgz")
      expect(script).toContain("HINACODE_SERVE_AUTO_UPDATE=0")
    })
  })

  it("resumes a stopped sandbox and keeps its auto-stop", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-old", "archived")
      fake.setMachineOutput({ stdout: PAIR_OUTPUT, stderr: "", exitCode: 0 })
      await runMachines(fake, (machines) => machines.connect({ sandbox: { id: "sb-old" } }))
      expect(fake.resumed).toEqual([{}])
      expect(fake.createBodies).toEqual([])
    })
  })

  it("reports the script's output when HinaCode does not start", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-live", "ready")
      fake.setMachineOutput({ stdout: "", stderr: "npm ERR! network", exitCode: 1 })
      const { result } = await runMachines(fake, (machines) =>
        Effect.flip(machines.connect({ sandbox: { id: "sb-live" } })),
      )
      expect(result._tag).toBe("BoatMachineError")
      expect(result.message).toContain("npm ERR! network")
    })
  })

  it("creates a thread's sandbox, clones the repository there and answers that machine's project", async () => {
    await withFake(async (fake) => {
      fake.setMachineOutput({ stdout: PAIR_OUTPUT, stderr: "", exitCode: 0 })
      const { result, cloud } = await runMachines(fake, (machines) =>
        machines.forThread({ repository: "acme/app/web", projectName: "app", setupScript: "pnpm i", create }),
      )
      expect(fake.createBodies[0]).toMatchObject({ labels: { hinacode: "thread" } })
      const [clone] = cloud.forwarded
      expect(clone?.method).toBe("projects.clone")
      expect(Schema.decodeUnknownSync(RpcMethods["projects.clone"].request)(clone?.payload)).toMatchObject({
        repository: { owner: "acme", name: "app" },
        rootPath: "~/app",
        name: "app",
        setupScript: "pnpm i",
      })
      expect(result).toMatchObject({ id: "project-2", environmentId: CLOUD_ID })
    })
  })

  it("refuses a thread machine for a project without a GitHub repository", async () => {
    await withFake(async (fake) => {
      const { result } = await runMachines(fake, (machines) =>
        Effect.flip(machines.forThread({ repository: "", projectName: "app", setupScript: null, create })),
      )
      expect(result._tag).toBe("BoatMachineError")
      expect(fake.createBodies).toEqual([])
    })
  })

  it("stops a thread's sandbox when settling it from the desktop answers", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-thread", "ready", { hinacode: "thread" })
      await runMachines(fake, (_, stub) =>
        Effect.gen(function* () {
          stub.threads = [{ settledAt: "2026-11-07T01:00:00.000Z" }]
          yield* stub.hooks!.answered(CLOUD_ID, "threads.update")
          expect(fake.stopped).toEqual([])
          yield* stub.hooks!.answered(CLOUD_ID, "threads.settle")
          expect(fake.stopped).toEqual(["sb-thread"])
        }),
      )
    })
  })

  it("stops a thread's sandbox once every started thread on it is settled", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-thread", "ready", { hinacode: "thread" })
      await runMachines(fake, (_, cloud) =>
        Effect.gen(function* () {
          cloud.threads = [{ settledAt: "2026-11-07T01:00:00.000Z" }, { id: "other", status: "running" }]
          yield* cloud.hooks!.pushed(CLOUD_ID, settledPush({ settledAt: "2026-11-07T01:00:00.000Z" }))
          expect(fake.stopped).toEqual([])
          cloud.threads = [
            { settledAt: "2026-11-07T01:00:00.000Z" },
            { id: "archived", status: "archived" },
            { id: "draft", status: "draft" },
          ]
          yield* cloud.hooks!.pushed(CLOUD_ID, settledPush({ settledAt: "2026-11-07T01:00:00.000Z" }))
          expect(fake.stopped).toEqual(["sb-thread"])
        }),
      )
    })
  })

  it("leaves a machine added in settings running when its threads settle", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-thread", "ready", { hinacode: "machine" })
      await runMachines(fake, (_, cloud) =>
        Effect.gen(function* () {
          cloud.threads = [{ settledAt: "2026-11-07T01:00:00.000Z" }]
          yield* cloud.hooks!.pushed(CLOUD_ID, settledPush({ settledAt: "2026-11-07T01:00:00.000Z" }))
        }),
      )
      expect(fake.stopped).toEqual([])
    })
  })

  it("resumes a stopped thread sandbox when a message is sent to it", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-thread", "archived", { hinacode: "thread" })
      const { cloud } = await runMachines(fake, (_, stub) => stub.hooks!.offlineMutation(CLOUD_ID))
      expect(fake.resumed).toEqual([{}])
      expect(cloud.reconnected).toEqual([CLOUD_ID])
    })
  })
})
