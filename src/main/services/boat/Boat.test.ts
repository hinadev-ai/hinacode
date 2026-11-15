import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Redacted } from "effect"
import { describe, expect, it } from "vitest"
import * as Db from "../../db/client.ts"
import { Secrets } from "../Secrets.ts"
import * as SecretsModule from "../Secrets.ts"
import { Boat, BOAT_API_KEY_SECRET, boatClient, layer as boatLayer } from "./Boat.ts"
import { API_KEY, BIG_STDOUT, BINARY_STDOUT, type FakeBoat, TAR_BYTES, withFake } from "./testing.ts"

const makeClient = (fake: FakeBoat, apiKey = API_KEY) =>
  boatClient({ baseUrl: fake.baseUrl, apiKey: Redacted.make(apiKey), pollSeconds: 0, signedRetrySeconds: [0, 0, 0, 0] })

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

  it("retries a dropped signed download for output over the direct limit", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-1", "ready")
      fake.dropSignedFetches(1)
      const result = await runEffect(makeClient(fake).exec("sb-1", { script: "big-stdout", timeoutSeconds: 30 }))
      expect(Buffer.from(result.stdout).equals(BIG_STDOUT)).toBe(true)
    })
  }, 60000)

  it("measures the output again after a timed-out exec and still returns it", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-1", "ready")
      const result = await runEffect(makeClient(fake).exec("sb-1", { script: "time-out", timeoutSeconds: 1 }))
      expect(result.exitCode).toBe(124)
      expect(Buffer.from(result.stdout)).toEqual(BINARY_STDOUT)
      expect([...fake.files.keys()].filter((path) => path.startsWith("/tmp/.hinacode-"))).toEqual([])
    })
  })

  it("exec and getFiles remove their guest temp files when a read fails", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-1", "ready")
      const client = makeClient(fake)
      const tempFiles = () => [...fake.files.keys()].filter((path) => path.startsWith("/tmp/.hinacode-"))
      fake.failFileReads(1)
      expect((await runFlip(client.exec("sb-1", { script: "cat /tmp/pic.png", timeoutSeconds: 30 })))._tag).toBe(
        "BoatError",
      )
      expect(tempFiles()).toEqual([])
      fake.failFileReads(1)
      expect((await runFlip(client.getFiles("sb-1", "/home/user/out")))._tag).toBe("BoatError")
      expect(tempFiles()).toEqual([])
    })
  })

  it("exec costs one request plus one per output stream and its cleanup, getFiles three", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-1", "ready")
      const client = makeClient(fake)
      const requestsOf = async <A, E>(effect: Effect.Effect<A, E>) => {
        fake.requests.length = 0
        await runEffect(effect)
        return [...fake.requests]
      }
      expect(await requestsOf(client.exec("sb-1", { script: "quiet", timeoutSeconds: 30 }))).toEqual([
        "POST /sandboxes/{id}/commands",
      ])
      expect(await requestsOf(client.exec("sb-1", { script: "stdout-only", timeoutSeconds: 30 }))).toEqual([
        "POST /sandboxes/{id}/commands",
        "GET /sandboxes/{id}/files",
        "POST /sandboxes/{id}/commands",
      ])
      expect(await requestsOf(client.exec("sb-1", { script: "cat /tmp/pic.png", timeoutSeconds: 30 }))).toEqual([
        "POST /sandboxes/{id}/commands",
        "GET /sandboxes/{id}/files",
        "GET /sandboxes/{id}/files",
        "POST /sandboxes/{id}/commands",
      ])
      expect(await requestsOf(client.getFiles("sb-1", "/home/user/out"))).toEqual([
        "POST /sandboxes/{id}/commands",
        "GET /sandboxes/{id}/files",
        "POST /sandboxes/{id}/commands",
      ])
    })
  })

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
        fake.commands.some(
          (command) =>
            command.includes("tar -cf") &&
            command.includes("--format=pax") &&
            command.includes("'/home/user/Downloads'"),
        ),
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

  it("lists environments and saved snapshots, and creates with every machine option", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-1", "archived")
      const client = makeClient(fake)
      expect(await runEffect(client.environments())).toEqual([
        { name: "base", isDefault: true },
        { name: "demo", isDefault: false },
      ])
      expect(await runEffect(client.savedSnapshots())).toEqual([
        { name: "tpl", status: "ready" },
        { name: "wip", status: "saving" },
      ])
      await runEffect(
        client.createSandbox({
          type: "small",
          ttlSeconds: null,
          environment: "demo",
          from: "bsh_code",
          noEnv: true,
          snapshots: false,
          monitoring: false,
          setupScript: "npm install",
        }),
      )
      expect(fake.createBodies[0]).toEqual({
        type: "small",
        ttlSeconds: null,
        env: {},
        labels: { hinacode: "1" },
        environment: "demo",
        from: "bsh_code",
        noEnv: true,
        snapshots: false,
        monitoring: false,
        setupScript: "npm install",
      })
      await runEffect(client.resume("sb-1", {}))
      expect(fake.resumed).toEqual([{}])
      await runEffect(client.hostPort("sb-1", 48081, { public: true, localhost: true }))
      expect(fake.hostBodies).toEqual([{ port: 48081, public: true, localhost: true }])
    })
  })

  it("limits and status have the expected shapes", async () => {
    await withFake(async (fake) => {
      fake.seedSandbox("sb-1", "ready")
      fake.seedSandbox("sb-2", "provisioning")
      fake.seedSandbox("sb-3", "archived")
      const client = makeClient(fake)
      expect(client.url).toBe(fake.baseUrl)
      expect(await runEffect(client.limits())).toEqual({ canStart: true, maxSandboxes: 100 })
      expect(await runEffect(client.status)).toEqual({ sandboxes: 2, maxSandboxes: 100 })
    })
  })
})

const withBoat = <A, E>(
  env: Readonly<Record<string, string>>,
  storedKey: string | null,
  use: (boat: typeof Boat.Service) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (storedKey !== null) yield* Secrets.use((secrets) => secrets.set(BOAT_API_KEY_SECRET, storedKey))
      return yield* Boat.use(use)
    }).pipe(
      Effect.provide(
        boatLayer(env).pipe(
          Layer.provideMerge(SecretsModule.layer),
          Layer.provide(Db.layer(":memory:")),
          Layer.provide(Layer.mergeAll(NodeServices.layer, SecretsModule.noKeyring)),
        ),
      ),
    ),
  )

describe("Boat service", () => {
  it("fails with BoatNotConfiguredError when neither env nor secret has a key", async () => {
    const error = await withBoat({}, null, (boat) => Effect.flip(boat.client))
    expect(error._tag).toBe("BoatNotConfiguredError")
    expect(error.message).toContain("BOAT_API_KEY")
  })

  it("BOAT_API_KEY and BOAT_API_BASE configure the client", async () => {
    const env = { BOAT_API_KEY: "env-key", BOAT_API_BASE: "http://127.0.0.1:9/api/v1/" }
    const result = await withBoat(env, null, (boat) => Effect.map(boat.client, (client) => client.url))
    expect(result).toBe("http://127.0.0.1:9/api/v1")
  })

  it("reads the key from Secrets when the env has none", async () => {
    const result = await withBoat({}, "stored-key", (boat) => Effect.map(boat.client, (client) => client.url))
    expect(result).toBe("https://boat.dev/api/v1")
  })
})
