import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { unlistedModel } from "../../shared/agent.ts"
import type { ExperimentalSettings } from "../../shared/domain.ts"
import { RPC_CHANNEL } from "../../shared/channels.ts"
import {
  PushEvent,
  type RpcEnvelope,
  type RpcMethod,
  type RpcRequestEncoded,
  type RpcResponseEncoded,
} from "../../shared/contract.ts"
import { pairingUrl } from "../../shared/remote.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import { OpencodeProvider } from "../agents/opencode/index.ts"
import { PiProvider } from "../agents/pi/index.ts"
import { MagpieProvider } from "../agents/magpie/index.ts"
import type { AgentProvider } from "../agents/provider.ts"
import { registerIpc } from "../ipc.ts"
import { RemoteAccess } from "../remote/access.ts"
import { unusedLoopbackPort } from "../remote/testing.ts"
import { Peers } from "../remote/peers.ts"
import { Environments } from "../services/Environments.ts"
import { Events, PushBroadcast, WindowPush } from "../services/Events.ts"
import { Messages } from "../services/Messages.ts"
import { Settings } from "../services/Settings.ts"
import { Threads } from "../services/Threads.ts"
import { CHUNK_BYTES } from "../services/Files.ts"
import { makeTestAppLayer } from "../testing.ts"
import { McpCredentials } from "./credentials.ts"

type IpcHandler = (event: { sender: object; senderFrame: Frame }, raw: unknown) => Promise<unknown>
interface Frame {
  readonly url: string
  readonly parent: Frame | null
}

const electron = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  userData: "",
  drags: [] as Array<{ file: string }>,
}))

vi.mock("electron", () => ({
  Notification: EventTarget,
  app: { getPath: () => electron.userData, focus: () => {}, getFileIcon: async () => ({}) },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  ipcMain: { handle: (channel: string, handler: IpcHandler) => electron.handlers.set(channel, handler) },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: () => ({ webContents: { startDrag: (item: { file: string }) => electron.drags.push(item) } }),
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { showItemInFolder: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false },
}))

const appUrl = "file:///opt/hinacode/out/renderer/index.html"

const provider = (id: AgentProvider["id"]): AgentProvider => ({
  id,
  listModels: Effect.succeed([unlistedModel(`${id}-model`, id)]),
  account: () => Effect.succeed({ type: "signedOut" }),
  planLimits: () => Effect.succeed(null),
  usage: () => Effect.succeed(null),
  listCommands: () => Effect.succeed([]),
  runTurn: () => Stream.empty,
  steer: () => Effect.succeed(true),
  interrupt: () => Effect.void,
  respondApproval: () => Effect.succeed(false),
  respondQuestion: () => Effect.void,
  setAccessMode: () => Effect.void,
})

const providers = Layer.mergeAll(
  Layer.succeed(ClaudeProvider, provider("claude")),
  Layer.succeed(CodexProvider, provider("codex")),
  Layer.succeed(MuseProvider, provider("muse")),
  Layer.succeed(OpencodeProvider, provider("opencode")),
  Layer.succeed(MagpieProvider, provider("magpie")),
  Layer.succeed(PiProvider, provider("pi")),
)

const makeCloudEvents = () => {
  const sinks = new Set<(event: typeof PushEvent.Encoded) => void>()
  const encode = Schema.encodeSync(PushEvent)
  return Layer.mergeAll(
    Layer.succeed(
      Events,
      Events.of({
        publish: (event) =>
          Effect.sync(() => {
            for (const sink of sinks) sink(encode(event))
          }),
      }),
    ),
    Layer.succeed(WindowPush, WindowPush.of({ send: () => Effect.void })),
    Layer.succeed(
      PushBroadcast,
      PushBroadcast.of({
        subscribe: (sink) =>
          Effect.acquireRelease(
            Effect.sync(() => void sinks.add(sink)),
            () => Effect.sync(() => void sinks.delete(sink)),
          ),
      }),
    ),
  )
}

const makeCloud = (dbPath: string) => makeTestAppLayer(dbPath, { providers, events: makeCloudEvents() })
const makeDesktop = (dbPath: string) => makeTestAppLayer(dbPath, { providers })
type Runtime = ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof makeDesktop>>, unknown>

let dir = ""
let cloud: Runtime
let desktop: Runtime

const invoke = <M extends RpcMethod>(method: M, payload: RpcRequestEncoded<M>, environment?: string) =>
  electron.handlers.get(RPC_CHANNEL)!(
    { sender: {}, senderFrame: { url: appUrl, parent: null } },
    { method, payload, environment },
  ) as Promise<RpcEnvelope<RpcResponseEncoded<M>>>

const result = <A>(envelope: RpcEnvelope<A>): A => {
  if ("error" in envelope) throw new Error(`${envelope.error.tag}: ${envelope.error.message}`)
  return envelope.result
}

const gitRepo = (path: string, origin: string) => {
  execFileSync("git", ["init", "-q", "-b", "main", path])
  execFileSync("git", [
    "-C",
    path,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ])
  execFileSync("git", ["-C", path, "remote", "add", "origin", origin])
}

const callAs = async (runtime: Runtime, threadId: string, name: string, args: Record<string, unknown> = {}) => {
  const { url, headers } = await runtime.runPromise(
    McpCredentials.use((credentials) => credentials.connectionFor(threadId)),
  )
  const client = new Client({ name: "test", version: "0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
  try {
    const called = await client.callTool({ name, arguments: args })
    const content = called.content as Array<{ text?: string }>
    return { text: content.map((part) => part.text ?? "").join(""), isError: called.isError === true }
  } finally {
    await client.close()
  }
}

const seedMessage = (runtime: Runtime, threadId: string, text: string) =>
  runtime.runPromise(
    Messages.use((messages) =>
      messages.insert({
        id: `${threadId}-m1`,
        threadId,
        role: "user",
        parts: [{ type: "text", text }],
        createdAt: "2026-10-26T00:00:00.000Z",
        completedAt: "2026-10-26T00:00:00.000Z",
        usage: null,
        forkPoint: null,
      }),
    ),
  )

const onMachine = (machine: { id: string; name: string }) =>
  `machine: ${machine.name} (${machine.id}), not this one, so its paths are not here`

let cloudId = ""
let desktopMachine = { id: "", name: "" }
let desktopThread = ""
let cloudThread = ""
let otherRepoThread = ""
let noOriginThread = ""
let desktopProject = ""
let cloudProject = ""
let desktopRepo = ""
let cloudRepo = ""

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kk-cross-machine-test-"))
  electron.userData = dir
  desktopRepo = join(dir, "desktop-repo")
  const otherRepo = join(dir, "other-repo")
  cloudRepo = join(dir, "cloud-repo")
  const desktopScratch = join(dir, "desktop-scratch")
  const cloudScratch = join(dir, "cloud-scratch")
  gitRepo(desktopRepo, "git@github.com:Acme/Web.git")
  gitRepo(otherRepo, "git@github.com:Acme/Other.git")
  gitRepo(cloudRepo, "git@github.com:Acme/Web.git")
  for (const scratch of [desktopScratch, cloudScratch]) execFileSync("git", ["init", "-q", scratch])
  mkdirSync(join(dir, "cloud"))
  mkdirSync(join(dir, "desktop"))

  const cloudPort = await unusedLoopbackPort()
  cloud = ManagedRuntime.make(makeCloud(join(dir, "cloud", "hinacode.sqlite")))
  await cloud.runPromise(
    Settings.use((settings) => settings.set({ remote: { enabled: true, bindHost: "127.0.0.1", port: cloudPort } })),
  )
  await vi.waitFor(async () =>
    expect((await cloud.runPromise(RemoteAccess.use((remote) => remote.status))).listening).toBe(true),
  )
  desktop = ManagedRuntime.make(makeDesktop(join(dir, "desktop", "hinacode.sqlite")))
  registerIpc(desktop, appUrl, () => {})
  desktopMachine = await desktop.runPromise(RemoteAccess.use((remote) => Effect.succeed(remote.identity)))

  const pairing = await cloud.runPromise(RemoteAccess.use((remote) => remote.pairing))
  const url = pairingUrl({ hosts: ["127.0.0.1"], port: pairing.port, token: pairing.token, relay: null })
  cloudId = result(await invoke("environments.add", { name: "cloud", pairingUrl: url })).id
  await vi.waitFor(async () =>
    expect(result(await invoke("environments.list", undefined)).clouds).toMatchObject([{ status: "connected" }]),
  )

  const web = result(await invoke("projects.create", { name: "web", rootPath: desktopRepo, setupScript: null }))
  const other = result(await invoke("projects.create", { name: "other", rootPath: otherRepo, setupScript: null }))
  const cloudWeb = result(
    await invoke("projects.create", { name: "web", rootPath: cloudRepo, setupScript: null }, cloudId),
  )
  desktopProject = web.id
  cloudProject = cloudWeb.id
  desktopThread = result(await invoke("threads.create", { projectId: web.id })).id
  otherRepoThread = result(await invoke("threads.create", { projectId: other.id })).id
  const scratch = result(
    await invoke("projects.create", { name: "scratch", rootPath: desktopScratch, setupScript: null }),
  )
  result(await invoke("projects.create", { name: "scratch", rootPath: cloudScratch, setupScript: null }, cloudId))
  noOriginThread = result(await invoke("threads.create", { projectId: scratch.id })).id
  cloudThread = result(await invoke("threads.create", { projectId: cloudWeb.id })).id
  await seedMessage(desktop, desktopThread, "hello from the desktop")
  await seedMessage(cloud, cloudThread, "hello from the cloud")

  await vi.waitFor(
    async () => {
      const threads = await cloud.runPromise(Peers.use((peers) => peers.ask("threads.list", undefined)))
      expect(threads.map((thread) => thread.id)).toContain(desktopThread)
    },
    { timeout: 10_000 },
  )
}, 60_000)

afterAll(async () => {
  await desktop.dispose()
  await cloud.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const setExperimental = (runtime: Runtime, patch: Partial<ExperimentalSettings>) =>
  runtime.runPromise(
    Settings.use((settings) =>
      Effect.flatMap(settings.get, ({ experimental }) => settings.set({ experimental: { ...experimental, ...patch } })),
    ),
  )

const heldDevices = (runtime: Runtime, threadId: string) =>
  runtime.runPromise(
    SqlClient.SqlClient.use(
      (sql) =>
        sql`SELECT device_id, client_id, client_name FROM thread_device WHERE thread_id = ${threadId} ORDER BY rowid`,
    ),
  )

describe("devices on another machine", () => {
  test("a desktop thread attaches devices on the machine chosen to run them, held in the desktop's name", async () => {
    await setExperimental(cloud, { devices: true })
    await setExperimental(desktop, { devices: true, devicesOn: cloudId })
    await vi.waitFor(async () => {
      await invoke("device.attach", { threadId: desktopThread, deviceId: "android:Hub_Pixel" })
      expect(await heldDevices(cloud, desktopThread)).toEqual([
        { deviceId: "android:Hub_Pixel", clientId: desktopMachine.id, clientName: desktopMachine.name },
      ])
    })
    expect(await heldDevices(desktop, desktopThread)).toEqual([])

    await setExperimental(desktop, { devicesOn: null })
    await vi.waitFor(async () => {
      await invoke("device.attach", { threadId: desktopThread, deviceId: "android:Local_Pixel" })
      expect(await heldDevices(desktop, desktopThread)).toEqual([
        { deviceId: "android:Local_Pixel", clientId: null, clientName: null },
      ])
    })
  })

  test("a device call that reaches the desktop over its remote server, as the web app's do, runs on the hub", async () => {
    await setExperimental(cloud, { devices: true })
    await setExperimental(desktop, { devices: true, devicesOn: cloudId })
    const desktopPort = await unusedLoopbackPort()
    await desktop.runPromise(
      Settings.use((settings) => settings.set({ remote: { enabled: true, bindHost: "127.0.0.1", port: desktopPort } })),
    )
    await vi.waitFor(async () =>
      expect((await desktop.runPromise(RemoteAccess.use((remote) => remote.status))).listening).toBe(true),
    )
    const pairing = await desktop.runPromise(RemoteAccess.use((remote) => remote.pairing))
    const url = pairingUrl({ hosts: ["127.0.0.1"], port: pairing.port, token: pairing.token, relay: null })
    const viewer = await cloud.runPromise(
      Environments.use((environments) => environments.add({ name: "desktop", pairingUrl: url })),
    )
    try {
      const attached = await cloud.runPromise(
        Environments.use((environments) =>
          environments.forward(viewer.id, {
            method: "device.attach",
            payload: { threadId: desktopThread, deviceId: "android:Web_Pixel" },
          }),
        ),
      )
      expect(attached).not.toHaveProperty("error")
      expect((await heldDevices(desktop, desktopThread)).map((row) => row.deviceId)).not.toContain("android:Web_Pixel")
      expect(await heldDevices(cloud, desktopThread)).toContainEqual({
        deviceId: "android:Web_Pixel",
        clientId: desktopMachine.id,
        clientName: desktopMachine.name,
      })
    } finally {
      await cloud.runPromise(Environments.use((environments) => environments.remove(viewer.id)))
      await desktop.runPromise(
        Settings.use((settings) =>
          settings.set({ remote: { enabled: false, bindHost: "127.0.0.1", port: desktopPort } }),
        ),
      )
      await setExperimental(desktop, { devicesOn: null })
    }
  }, 30_000)

  test("the desktop points a cloud's devices at a machine the cloud paired, and runs them there", async () => {
    await setExperimental(desktop, { devices: true })
    const desktopPort = await unusedLoopbackPort()
    await desktop.runPromise(
      Settings.use((settings) => settings.set({ remote: { enabled: true, bindHost: "127.0.0.1", port: desktopPort } })),
    )
    await vi.waitFor(async () =>
      expect((await desktop.runPromise(RemoteAccess.use((remote) => remote.status))).listening).toBe(true),
    )
    const pairing = await desktop.runPromise(RemoteAccess.use((remote) => remote.pairing))
    const url = pairingUrl({ hosts: ["127.0.0.1"], port: pairing.port, token: pairing.token, relay: null })
    const hub = await cloud.runPromise(
      Environments.use((environments) => environments.add({ name: "desktop", pairingUrl: url })),
    )
    const cloudMachine = await cloud.runPromise(RemoteAccess.use((remote) => Effect.succeed(remote.identity)))
    try {
      await vi.waitFor(async () =>
        expect(result(await invoke("devices.hubs", undefined, cloudId))).toEqual([
          { id: hub.id, name: "desktop", status: "connected" },
        ]),
      )
      expect(result(await invoke("devices.hubs", undefined))).toEqual([
        { id: cloudId, name: "cloud", status: "connected" },
      ])
      expect(result(await invoke("devices.checks", { hub: hub.id }, cloudId))).toEqual(
        result(await invoke("devices.checks", {})),
      )

      result(await invoke("settings.set", { experimental: { devices: true, devicesOn: hub.id } }, cloudId))
      await vi.waitFor(async () => {
        await invoke("device.attach", { threadId: cloudThread, deviceId: "android:Remote_Pixel" })
        expect(await heldDevices(desktop, cloudThread)).toEqual([
          { deviceId: "android:Remote_Pixel", clientId: cloudMachine.id, clientName: cloudMachine.name },
        ])
      })
      expect(await heldDevices(cloud, cloudThread)).toEqual([])
    } finally {
      await setExperimental(cloud, { devicesOn: null })
      await cloud.runPromise(Environments.use((environments) => environments.remove(hub.id)))
      await desktop.runPromise(
        Settings.use((settings) =>
          settings.set({ remote: { enabled: false, bindHost: "127.0.0.1", port: desktopPort } }),
        ),
      )
    }
  }, 30_000)

  test("the hub serves a client's device calls itself even when it runs its own devices elsewhere", async () => {
    await setExperimental(cloud, { devices: true, devicesOn: "a-machine-the-hub-uses" })
    await setExperimental(desktop, { devices: true, devicesOn: cloudId })
    try {
      await vi.waitFor(async () => {
        await invoke("device.attach", { threadId: desktopThread, deviceId: "android:Hub_Watch" })
        expect((await heldDevices(cloud, desktopThread)).map((row) => row.deviceId)).toContain("android:Hub_Watch")
      })
    } finally {
      await setExperimental(cloud, { devicesOn: null })
      await setExperimental(desktop, { devicesOn: null })
    }
  })
})

describe("devices held on another machine", () => {
  test("the hub learns the thread's title, and releases its devices once the thread is archived", async () => {
    await setExperimental(cloud, { devices: true })
    await setExperimental(desktop, { devices: true, devicesOn: cloudId })
    const thread = result(await invoke("threads.create", { projectId: desktopProject })).id
    await invoke("threads.update", { id: thread, title: "Fix login screen" })
    await vi.waitFor(async () => {
      await invoke("device.attach", { threadId: thread, deviceId: "android:Hub_Tablet" })
      expect(await heldDevices(cloud, thread)).toHaveLength(1)
    })
    await vi.waitFor(
      async () =>
        expect(
          await cloud.runPromise(
            SqlClient.SqlClient.use((sql) => sql`SELECT thread_title FROM thread_device WHERE thread_id = ${thread}`),
          ),
        ).toEqual([{ threadTitle: "Fix login screen" }]),
      { timeout: 12_000 },
    )

    result(await invoke("threads.archive", { threadId: thread }))
    await vi.waitFor(async () => expect(await heldDevices(cloud, thread)).toEqual([]), { timeout: 12_000 })
  }, 30_000)

  test("an agent hears at once that the machine chosen to run devices is gone", async () => {
    await setExperimental(desktop, { devices: true, devicesOn: "a-machine-that-was-removed" })
    expect(await callAs(desktop, desktopThread, "device_screenshot")).toStrictEqual({
      isError: true,
      text: "The machine chosen to run devices is no longer paired. Pick another in Settings > Experimental > Run devices on.",
    })
    await setExperimental(desktop, { devicesOn: null })
  })

  test("switching back to this machine releases what the desktop held on the hub", async () => {
    await setExperimental(desktop, { devices: true, devicesOn: cloudId })
    await vi.waitFor(async () => {
      await invoke("device.attach", { threadId: desktopThread, deviceId: "android:Hub_Phone" })
      expect((await heldDevices(cloud, desktopThread)).map((row) => row.deviceId)).toContain("android:Hub_Phone")
    })

    await setExperimental(desktop, { devicesOn: null })
    await vi.waitFor(async () => expect(await heldDevices(cloud, desktopThread)).toEqual([]), { timeout: 12_000 })
  }, 30_000)
})

describe("dragging a file out of the window", () => {
  test("hands the OS a file of a desktop project where it lies", async () => {
    mkdirSync(join(desktopRepo, "art"), { recursive: true })
    writeFileSync(join(desktopRepo, "art", "header.png"), "desktop pixels")
    electron.drags.length = 0
    result(await invoke("shell.dragFile", { root: desktopRepo, path: "art/header.png" }))
    expect(electron.drags.map((drag) => drag.file)).toEqual([realpathSync(join(desktopRepo, "art", "header.png"))])
  })

  test("copies a file of a cloud project to this machine under its own name first", async () => {
    mkdirSync(join(cloudRepo, "art"), { recursive: true })
    writeFileSync(join(cloudRepo, "art", "header.png"), "cloud pixels")
    electron.drags.length = 0
    result(await invoke("shell.dragFile", { root: cloudRepo, path: "art/header.png" }))
    const [drag] = electron.drags
    expect(drag?.file).toBe(join(tmpdir(), "hinacode-drag", "header.png"))
    expect(readFileSync(drag!.file, "utf8")).toBe("cloud pixels")
  })
})

describe("downloading a file of a cloud project", () => {
  test("saves it whole in Downloads, beside an earlier copy instead of over it", async () => {
    const bytes = randomBytes(CHUNK_BYTES * 2 + 123)
    writeFileSync(join(cloudRepo, "build.zip"), bytes)
    const first = result(await invoke("shell.download", { root: cloudRepo, path: "build.zip" }))
    const second = result(await invoke("shell.download", { root: cloudRepo, path: "build.zip" }))
    expect([first.path, second.path]).toEqual([join(dir, "build.zip"), join(dir, "build (1).zip")])
    expect(readFileSync(second.path).equals(bytes)).toBe(true)
  })

  test("leaves nothing behind when the file is gone", async () => {
    const download = await invoke("shell.download", { root: cloudRepo, path: "missing.zip" })
    expect("error" in download && download.error.tag).toBe("FsAccessError")
    expect(existsSync(join(dir, "missing.zip"))).toBe(false)
  })
})

describe("thread tools across machines", () => {
  test("a desktop thread reads a cloud thread of the same repository", async () => {
    const read = await callAs(desktop, desktopThread, "read_thread", { threadId: cloudThread })
    expect(read.isError).toBe(false)
    expect(read.text).toContain(`thread_id: ${cloudThread}`)
    expect(read.text).toContain(onMachine({ id: cloudId, name: "cloud" }))
    expect(read.text).toContain("hello from the cloud")
  })

  test("a cloud thread reads a desktop thread of the same repository through the hub", async () => {
    const read = await callAs(cloud, cloudThread, "read_thread", { threadId: desktopThread })
    expect(read.isError).toBe(false)
    expect(read.text).toContain(`thread_id: ${desktopThread}`)
    expect(read.text).toContain(onMachine(desktopMachine))
    expect(read.text).toContain("hello from the desktop")
  })

  test("a cloud thread lists the desktop's threads of the same repository and itself once", async () => {
    const listed = await callAs(cloud, cloudThread, "list_threads")
    expect(listed.isError).toBe(false)
    const threads = JSON.parse(listed.text) as Array<{ id: string; self?: true; machine?: unknown }>
    expect(threads.toSorted((a, b) => a.id.localeCompare(b.id))).toMatchObject(
      [
        { id: cloudThread, self: true },
        { id: desktopThread, machine: desktopMachine },
      ].toSorted((a, b) => a.id.localeCompare(b.id)),
    )
    expect(threads).toHaveLength(2)
    expect(threads.find((thread) => thread.id === cloudThread)).not.toHaveProperty("machine")
  })

  test("a cloud thread cannot read a desktop thread of another repository", async () => {
    const read = await callAs(cloud, cloudThread, "read_thread", { threadId: otherRepoThread })
    expect(read).toStrictEqual({ isError: true, text: `Thread ${otherRepoThread} no longer exists.` })
  })

  test("a desktop thread reads a desktop thread of another repository and names its project", async () => {
    const read = await callAs(desktop, desktopThread, "read_thread", { threadId: otherRepoThread })
    expect(read.isError).toBe(false)
    expect(read.text).toContain(`thread_id: ${otherRepoThread}`)
    expect(read.text).toMatch(
      /<environment>\nproject: other \(.+other-repo\)\nworkspace: project root\n<\/environment>/,
    )
    expect(read.text).not.toContain("machine:")
  })

  test("a desktop thread cannot send to or stop a desktop thread of another repository", async () => {
    for (const name of ["send_to_thread", "stop_thread"]) {
      const refused = await callAs(desktop, desktopThread, name, { threadId: otherRepoThread, prompt: "hi" })
      expect(refused).toStrictEqual({ isError: true, text: `Thread ${otherRepoThread} is not in this project.` })
    }
  })

  test("search_threads on each machine finds that machine's threads of every project", async () => {
    await seedMessage(desktop, otherRepoThread, "the other repo also says hello")
    const onDesktop = JSON.parse((await callAs(desktop, desktopThread, "search_threads", { query: "hello" })).text)
    expect(onDesktop.map((hit: { id: string }) => hit.id).toSorted()).toStrictEqual(
      [desktopThread, otherRepoThread].toSorted(),
    )
    const onCloud = JSON.parse((await callAs(cloud, cloudThread, "search_threads", { query: "hello" })).text)
    expect(onCloud.map((hit: { id: string }) => hit.id)).toStrictEqual([cloudThread])
  })

  test("a cloud thread sends to a desktop thread through the hub, with a model and effort", async () => {
    const sent = await callAs(cloud, cloudThread, "send_to_thread", {
      threadId: desktopThread,
      prompt: "hi from the cloud",
      model: "claude-other",
      effort: "high",
    })
    expect(sent).toStrictEqual({ isError: false, text: `Started a new turn on thread ${desktopThread}.` })
    const transcript = result(await invoke("threads.transcript", { threadId: desktopThread }))
    expect(JSON.stringify(transcript.messages)).toContain("hi from the cloud")
    const threads = result(await invoke("threads.list", undefined))
    expect(threads.find((thread) => thread.id === desktopThread)).toMatchObject({
      model: "claude-other",
      effort: "high",
    })
  })

  test("a desktop thread sends to a cloud thread, and stops it", async () => {
    const sent = await callAs(desktop, desktopThread, "send_to_thread", {
      threadId: cloudThread,
      prompt: "hi from the desktop",
    })
    expect(sent).toStrictEqual({ isError: false, text: `Started a new turn on thread ${cloudThread}.` })
    const transcript = result(await invoke("threads.transcript", { threadId: cloudThread }))
    expect(JSON.stringify(transcript.messages)).toContain("hi from the desktop")
    const stopped = await callAs(desktop, desktopThread, "stop_thread", { threadId: cloudThread })
    expect(stopped).toStrictEqual({ isError: false, text: `Interrupted thread ${cloudThread}.` })
  })

  test("a cloud thread cannot send to a desktop thread of another repository", async () => {
    const sent = await callAs(cloud, cloudThread, "send_to_thread", { threadId: otherRepoThread, prompt: "hi" })
    expect(sent).toStrictEqual({ isError: true, text: `Thread ${otherRepoThread} no longer exists.` })
  })

  test("a desktop thread lists both machines and which ones hold its repository", async () => {
    const web = await callAs(desktop, desktopThread, "list_machines")
    expect(JSON.parse(web.text)).toStrictEqual([
      { ...desktopMachine, self: true, hasProject: true },
      { id: cloudId, name: "cloud", hasProject: true },
    ])
    const other = await callAs(desktop, otherRepoThread, "list_machines")
    expect(JSON.parse(other.text)).toStrictEqual([
      { ...desktopMachine, self: true, hasProject: true },
      { id: cloudId, name: "cloud", hasProject: false },
    ])
    const scratch = await callAs(desktop, noOriginThread, "list_machines")
    expect(JSON.parse(scratch.text)).toStrictEqual([
      { ...desktopMachine, self: true, hasProject: true },
      { id: cloudId, name: "cloud", hasProject: false },
    ])
  })

  test("a cloud thread lists the desktop through the hub, and itself once", async () => {
    const listed = await callAs(cloud, cloudThread, "list_machines")
    const machines = JSON.parse(listed.text) as Array<{ id: string }>
    expect(machines).toMatchObject([
      { id: cloudId, self: true, hasProject: true },
      { ...desktopMachine, hasProject: true },
    ])
    expect(machines).toHaveLength(2)
  })

  test("a desktop thread creates a thread on the cloud in its own access mode and starts it", async () => {
    await desktop.runPromise(Threads.use((threads) => threads.update({ id: desktopThread, accessMode: "auto" })))
    const created = await callAs(desktop, desktopThread, "create_thread", {
      title: "on the cloud",
      prompt: "run this on the cloud",
      model: "claude-cloud",
      machine: cloudId,
    })
    expect(created.isError).toBe(false)
    const id = created.text.match(/^Created thread (\S+) "on the cloud" on cloud and sent it the prompt\.$/)?.[1]
    expect(id).toBeDefined()
    const onCloud = await cloud.runPromise(Threads.use((threads) => threads.get(id!)))
    expect(onCloud).toMatchObject({
      projectId: cloudProject,
      title: "on the cloud",
      provider: "claude",
      model: "claude-cloud",
      accessMode: "auto",
      createdBy: `thread:${desktopThread}`,
    })
    await vi.waitFor(async () => {
      const transcript = result(await invoke("threads.transcript", { threadId: id! }))
      expect(JSON.stringify(transcript.messages)).toContain("run this on the cloud")
    })
  })

  test("a cloud thread creates a thread on the desktop through the hub", async () => {
    const created = await callAs(cloud, cloudThread, "create_thread", {
      title: "on the desktop",
      prompt: "run this on the desktop",
      machine: desktopMachine.id,
    })
    expect(created.isError).toBe(false)
    const id = created.text.match(/^Created thread (\S+) "on the desktop" on /)?.[1]
    const onDesktop = await desktop.runPromise(Threads.use((threads) => threads.get(id!)))
    expect(onDesktop).toMatchObject({
      projectId: desktopProject,
      title: "on the desktop",
      createdBy: `thread:${cloudThread}`,
    })
    await vi.waitFor(async () => {
      const transcript = result(await invoke("threads.transcript", { threadId: id! }))
      expect(JSON.stringify(transcript.messages)).toContain("run this on the desktop")
    })
  })

  test("creating a thread on a machine without the repository asks the user to add it", async () => {
    const created = await callAs(desktop, otherRepoThread, "create_thread", {
      title: "nowhere",
      prompt: "hi",
      machine: cloudId,
    })
    expect(created).toStrictEqual({
      isError: true,
      text: "cloud has no project for acme/other. Ask the user to add acme/other as a project on cloud, then try again.",
    })
  })

  test("creating a thread on an unknown machine points at list_machines", async () => {
    const created = await callAs(desktop, desktopThread, "create_thread", { title: "x", prompt: "hi", machine: "nope" })
    expect(created).toStrictEqual({ isError: true, text: "No machine has id nope. Call list_machines for the ids." })
  })

  test("a cloud with no desktop connected says so instead of calling the thread gone", async () => {
    result(await invoke("environments.remove", { id: cloudId }))
    await vi.waitFor(async () => {
      const read = await callAs(cloud, cloudThread, "read_thread", { threadId: desktopThread })
      expect(read).toStrictEqual({
        isError: true,
        text: `Thread ${desktopThread} is not on this machine, and the other machines are out of reach: This machine is not connected to any other HinaCode machine.`,
      })
    })
  })
})
