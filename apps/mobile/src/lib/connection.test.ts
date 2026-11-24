import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  approvalCode,
  type Channel,
  commitment,
  encodeKey,
  generateKeyPair,
  newNonce,
  REMOTE_PROLOGUE,
  respond,
} from "@shared/noise.ts"
import { RELAY_DELAY_MS } from "@shared/remote.ts"
import type { RememberedAnswers } from "./connection"
import type { StoredServer } from "./stored-target"

const HOST = generateKeyPair()
const HOST_KEY = encodeKey(HOST.publicKey)
const utf8 = new TextDecoder()

class FakeSocket {
  static all: FakeSocket[] = []
  binaryType = "blob"
  onopen: (() => void) | null = null
  onmessage: ((message: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  readonly raw: Uint8Array[] = []
  readonly sent: { type: string; id?: number; method?: string; payload?: unknown; nonce?: string }[] = []
  channel: Channel | null = null
  serverNonce = newNonce()

  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  send(data: Uint8Array) {
    this.raw.push(data)
    if (this.channel !== null) this.sent.push(JSON.parse(utf8.decode(this.channel.decrypt(data))))
  }
  close() {}

  handshake() {
    this.onopen?.()
    const { message, channel } = respond({ prologue: REMOTE_PROLOGUE, local: HOST, message: this.raw[0]! }).reply(
      new Uint8Array(0),
    )
    this.channel = channel
    this.onmessage?.({ data: message.slice().buffer })
  }
  pend() {
    this.receive({ type: "pending", commitment: bytesToHex(commitment(this.serverNonce)) })
    this.receive({ type: "approval", nonce: bytesToHex(this.serverNonce) })
  }
  code() {
    const sent = this.sent.find((frame) => frame.type === "approval")!
    return approvalCode(this.channel!.handshakeHash, hexToBytes(sent.nonce!), this.serverNonce)
  }
  ready(environment?: { id: string; name: string }, relay?: string, hosts?: readonly string[]) {
    if (this.channel === null) this.handshake()
    this.receive({
      type: "ready",
      version: 2,
      features: ["call-keys"],
      ...(environment && { environment }),
      relay,
      hosts,
    })
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: this.channel!.encrypt(utf8ToBytes(JSON.stringify(frame))).slice().buffer })
  }
  calls(method: string) {
    return this.sent.filter((frame) => frame.type === "call" && frame.method === method)
  }
  answer(method: string, result: unknown) {
    for (const call of this.calls(method)) this.receive({ type: "result", id: call.id, envelope: { result } })
  }
  fail(method: string, error: { tag: string; message: string }) {
    for (const call of this.calls(method)) this.receive({ type: "result", id: call.id, envelope: { error } })
  }
}

vi.stubGlobal("WebSocket", FakeSocket)

const {
  call,
  confirmHost,
  onRemembered,
  reconnectNow,
  restoreAnswers,
  setDevice,
  setForeground,
  setServers,
  storedServers,
  useConnection,
} = await import("./connection")

setDevice({ key: generateKeyPair(), name: "iPhone" })

const server = (id: string, port: number): StoredServer => ({
  id,
  name: null,
  environmentId: null,
  hosts: ["127.0.0.1"],
  port,
  relay: null,
  key: HOST_KEY,
  secret: null,
  verified: true,
  source: "pairing",
})

const socketOf = (port: number) => FakeSocket.all.findLast((socket) => socket.url.includes(`:${port}/`))!

const serverState = (id: string) => useConnection.getState().servers.find((entry) => entry.id === id)!

const project = (id: string) => ({
  id,
  name: id,
  rootPath: `/srv/${id}`,
  setupScript: null,
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
})

const thread = (id: string, projectId: string) => ({
  id,
  projectId,
  worktreeId: null,
  title: id,
  provider: "claude",
  model: "sonnet",
  effort: null,
  fastMode: false,
  accessMode: "supervised",
  accountId: null,
  providerSessionId: null,
  status: "idle",
  usageLimit: null,
  sortIndex: 0,
  pinnedAt: null,
  snoozedUntil: null,
  queue: [],
  createdBy: "user",
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
})

const artifact = (id: string) => ({
  id,
  title: id,
  entry: "index.html",
  version: 1,
  files: [],
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
})

const issue = (identifier: string) => ({
  id: identifier,
  identifier,
  title: identifier,
  url: `https://linear.app/team/issue/${identifier}`,
  state: { name: "Todo", type: "unstarted" },
  priority: 0,
  updatedAt: "2026-10-24T00:00:00.000Z",
})

const unanswered = (promise: Promise<unknown>) => void promise.catch(() => {})

const PROMISE_HOPS_PER_CALL = 10

const flush = async () => {
  for (let hop = 0; hop < PROMISE_HOPS_PER_CALL; hop++) await Promise.resolve()
}

beforeEach(() => {
  FakeSocket.all = []
  setServers([server("a", 1001), server("b", 1002)])
  socketOf(1001).ready({ id: "env-a", name: "studio" })
  socketOf(1002).ready({ id: "env-b", name: "home-server" })
})

afterEach(() => setServers([]))

describe("call", () => {
  it("merges every server's projects and marks each with its server", async () => {
    const listing = call("projects.list", undefined)
    socketOf(1001).answer("projects.list", [project("web")])
    socketOf(1002).answer("projects.list", [project("api")])
    expect((await listing).map((entry) => [entry.name, entry.environmentId])).toEqual([
      ["web", "a"],
      ["api", "b"],
    ])
  })

  it("sends a thread's call to the server that listed it", async () => {
    const listing = call("threads.list", undefined)
    socketOf(1001).answer("threads.list", [thread("t-web", "web")])
    socketOf(1002).answer("threads.list", [thread("t-api", "api")])
    await listing

    unanswered(call("threads.send", { threadId: "t-api", prompt: "hi" }))
    await flush()
    expect(socketOf(1001).calls("threads.send")).toHaveLength(0)
    expect(socketOf(1002).calls("threads.send")).toHaveLength(1)
  })

  it("waits for the lists before routing an id no server has claimed", async () => {
    unanswered(call("threads.transcript", { threadId: "t-api" }))
    await flush()
    expect(socketOf(1002).calls("threads.transcript")).toHaveLength(0)

    const listing = call("threads.list", undefined)
    socketOf(1001).answer("threads.list", [])
    socketOf(1002).answer("threads.list", [thread("t-api", "api")])
    await listing
    await flush()
    expect(socketOf(1002).calls("threads.transcript")).toHaveLength(1)
  })

  it("lists an offline server's last answer without waiting for it", async () => {
    const first = call("projects.list", undefined)
    socketOf(1001).answer("projects.list", [project("web")])
    socketOf(1002).answer("projects.list", [project("api")])
    await first

    socketOf(1002).onclose?.({ code: 1006 })
    expect(useConnection.getState().servers.map((entry) => entry.status)).toEqual(["connected", "offline"])
    expect(useConnection.getState().status).toBe("connected")

    const second = call("projects.list", undefined)
    socketOf(1001).answer("projects.list", [project("web"), project("docs")])
    expect((await second).map((entry) => entry.name)).toEqual(["web", "docs", "api"])
  })

  it("rejects a list when every server failed and none has a saved answer", async () => {
    const listing = call("linear.issues", undefined)
    socketOf(1001).fail("linear.issues", { tag: "LinearError", message: "bad key" })
    socketOf(1002).fail("linear.issues", { tag: "LinearError", message: "bad key" })
    await expect(listing).rejects.toMatchObject({ tag: "LinearError", message: "bad key" })
  })

  it("lists the servers that answered when another one failed", async () => {
    const listing = call("projects.list", undefined)
    socketOf(1001).fail("projects.list", { tag: "SqlError", message: "locked" })
    socketOf(1002).answer("projects.list", [project("api")])
    expect((await listing).map((entry) => entry.name)).toEqual(["api"])
  })

  it("lists a failing server's saved answer instead of its error", async () => {
    setServers([])
    setServers([server("a", 1001)])
    restoreAnswers("a", { "threads.list": { payload: "null", result: [thread("t-saved", "web")] } })
    socketOf(1001).ready({ id: "env-a", name: "studio" })
    const listing = call("threads.list", undefined)
    socketOf(1001).fail("threads.list", { tag: "SqlError", message: "locked" })
    expect((await listing).map((entry) => entry.id)).toEqual(["t-saved"])
  })

  it("lists the answers saved at the last launch while the server is still connecting", async () => {
    setServers([])
    setServers([server("a", 1001)])
    restoreAnswers("a", { "threads.list": { payload: "null", result: [thread("t-saved", "web")] } })
    expect((await call("threads.list", undefined)).map((entry) => entry.id)).toEqual(["t-saved"])
  })

  it("sends a call on a saved thread to its server once it reconnects, after an offline launch", async () => {
    setServers([])
    setServers([server("a", 1001), server("b", 1002)])
    restoreAnswers("a", { "threads.list": { payload: "null", result: [thread("t-saved", "web")] } })
    restoreAnswers("b", { "threads.list": { payload: "null", result: [] } })
    socketOf(1001).onclose?.({ code: 1006 })
    socketOf(1002).onclose?.({ code: 1006 })
    expect((await call("threads.list", undefined)).map((entry) => entry.id)).toEqual(["t-saved"])
    expect(useConnection.getState().servers.map((entry) => entry.listed)).toEqual([false, false])

    const sending = call("threads.send", { threadId: "t-saved", prompt: "hi" })
    let failure: unknown
    sending.catch((cause) => (failure = cause))
    await flush()
    expect(failure).toBeUndefined()

    reconnectNow("a")
    socketOf(1001).ready({ id: "env-a", name: "studio" })
    await flush()
    expect(socketOf(1001).calls("threads.send")).toHaveLength(1)
  })

  it("does not route to a server unpaired before its saved answers were read", async () => {
    setServers([server("b", 1002), server("c", 1003)])
    socketOf(1003).ready({ id: "env-c", name: "laptop" })
    restoreAnswers("a", { "threads.list": { payload: "null", result: [thread("t-saved", "web")] } })
    const listing = call("threads.list", undefined)
    socketOf(1002).answer("threads.list", [])
    socketOf(1003).answer("threads.list", [])
    expect(await listing).toEqual([])

    await expect(call("threads.send", { threadId: "t-saved", prompt: "hi" })).rejects.toMatchObject({
      tag: "NotFoundError",
    })
  })

  it("routes by a live answer over another server's saved one", async () => {
    socketOf(1001).onclose?.({ code: 1006 })
    const listing = call("threads.list", undefined)
    socketOf(1002).answer("threads.list", [thread("t-moved", "api")])
    await listing
    restoreAnswers("a", { "threads.list": { payload: "null", result: [thread("t-moved", "web")] } })

    unanswered(call("threads.send", { threadId: "t-moved", prompt: "hi" }))
    await flush()
    expect(socketOf(1002).calls("threads.send")).toHaveLength(1)
  })

  it("reports each fresh answer, to be saved for the next launch", async () => {
    const saved: unknown[] = []
    const stop = onRemembered((serverId, answers) => saved.push([serverId, answers["threads.list"]?.result]))
    const listing = call("threads.list", undefined)
    socketOf(1001).answer("threads.list", [thread("t-web", "web")])
    socketOf(1002).answer("threads.list", [])
    await listing
    stop()
    expect(saved).toEqual([
      ["a", [thread("t-web", "web")]],
      ["b", []],
    ])
  })

  it("saves only the lists a relaunch reads back, so a search query never rewrites them", async () => {
    const saves: [string, RememberedAnswers][] = []
    const stop = onRemembered((serverId, answers) => saves.push([serverId, answers]))
    const launchLists = { "projects.list": [], "worktrees.list": [], "threads.list": [thread("t-web", "web")] }
    for (const [method, result] of Object.entries(launchLists)) {
      const listing = call(method as keyof typeof launchLists, undefined)
      socketOf(1001).answer(method, result)
      socketOf(1002).answer(method, [])
      await listing
    }
    const pullRequests = call("pullRequests.all", undefined)
    socketOf(1001).answer("pullRequests.all", [])
    socketOf(1002).answer("pullRequests.all", [])
    await pullRequests
    const savedAtLaunch = saves.length

    for (const query of ["he", "hel", "hello"]) {
      const searching = call("search.threads", { query, limit: 30 })
      socketOf(1001).answer("search.threads", [])
      socketOf(1002).answer("search.threads", [])
      await searching
    }
    stop()

    expect(saves.length).toBe(savedAtLaunch)
    const [, lastSaved] = saves.findLast(([serverId]) => serverId === "a")!
    expect(new Set(Object.keys(lastSaved))).toEqual(
      new Set(["projects.list", "threads.list", "worktrees.list", "pullRequests.all"]),
    )

    setServers([])
    setServers([server("a", 1001)])
    restoreAnswers("a", lastSaved)
    expect((await call("threads.list", undefined)).map((entry) => entry.id)).toEqual(["t-web"])

    socketOf(1001).ready({ id: "env-a", name: "studio" })
    const offline = call("threads.list", undefined)
    socketOf(1001).fail("threads.list", { tag: "SqlError", message: "locked" })
    expect((await offline).map((entry) => entry.id)).toEqual(["t-web"])
  })

  it("lists an unreachable server's saved artifacts and Linear issues after a relaunch", async () => {
    const saved = new Map<string, RememberedAnswers>()
    const stop = onRemembered((serverId, answers) => saved.set(serverId, answers))
    const artifacts = call("artifacts.list", undefined)
    socketOf(1001).answer("artifacts.list", [artifact("art-web")])
    socketOf(1002).answer("artifacts.list", [artifact("art-api")])
    await artifacts
    const issues = call("linear.issues", undefined)
    socketOf(1001).answer("linear.issues", [])
    socketOf(1002).answer("linear.issues", [issue("ENG-1")])
    await issues
    stop()

    setServers([])
    setServers([server("a", 1001), server("b", 1002)])
    restoreAnswers("a", saved.get("a") ?? {})
    restoreAnswers("b", saved.get("b") ?? {})
    socketOf(1001).ready({ id: "env-a", name: "studio" })
    socketOf(1002).onclose?.({ code: 1006 })

    const relaunchedArtifacts = call("artifacts.list", undefined)
    socketOf(1001).answer("artifacts.list", [artifact("art-web")])
    expect((await relaunchedArtifacts).map((entry) => entry.id)).toEqual(["art-web", "art-api"])
    const relaunchedIssues = call("linear.issues", undefined)
    socketOf(1001).answer("linear.issues", [])
    expect((await relaunchedIssues).map((entry) => entry.identifier)).toEqual(["ENG-1"])
  })

  it("reads an artifact on the thread's server before any server has claimed it", async () => {
    unanswered(call("artifacts.readDocument", { id: "doc-1" }, { server: "b" }))
    await flush()
    expect(socketOf(1001).calls("artifacts.readDocument")).toHaveLength(0)
    expect(socketOf(1002).calls("artifacts.readDocument")).toHaveLength(1)
  })

  it("prefers the server that claimed an artifact over the one a call names", async () => {
    const listing = call("artifacts.list", undefined)
    socketOf(1001).answer("artifacts.list", [
      {
        id: "doc-1",
        title: "Plan",
        entry: "document.md",
        version: 1,
        files: [],
        createdAt: "2026-10-24T00:00:00.000Z",
        updatedAt: "2026-10-24T00:00:00.000Z",
      },
    ])
    socketOf(1002).answer("artifacts.list", [])
    await listing

    unanswered(call("artifacts.readDocument", { id: "doc-1" }, { server: "b" }))
    await flush()
    expect(socketOf(1001).calls("artifacts.readDocument")).toHaveLength(1)
    expect(socketOf(1002).calls("artifacts.readDocument")).toHaveLength(0)
  })

  it("still refuses an unclaimed artifact when no server is named", async () => {
    const listing = call("threads.list", undefined)
    socketOf(1001).answer("threads.list", [])
    socketOf(1002).answer("threads.list", [])
    await listing

    await expect(call("artifacts.readDocument", { id: "doc-1" })).rejects.toMatchObject({ tag: "NotFoundError" })
  })

  it("sends a named call to the server it names", async () => {
    unanswered(call("projects.create", { name: "api", rootPath: "/srv/api", setupScript: null }, { server: "b" }))
    await flush()
    expect(socketOf(1001).calls("projects.create")).toHaveLength(0)
    expect(socketOf(1002).calls("projects.create")).toHaveLength(1)
  })
})

describe("servers", () => {
  it("keeps restored servers offline during a background launch until the app returns", () => {
    setServers([])
    FakeSocket.all = []
    setForeground(false)
    try {
      setServers([server("a", 1001)])
      expect(FakeSocket.all).toHaveLength(0)
      expect(useConnection.getState().status).toBe("offline")
      setForeground(true)
      expect(FakeSocket.all).toHaveLength(1)
      socketOf(1001).ready({ id: "env-a", name: "studio" })
      expect(useConnection.getState().status).toBe("connected")
    } finally {
      setForeground(true)
    }
  })

  it("names each server after its first handshake", () => {
    expect(useConnection.getState().servers.map((entry) => [entry.name, entry.environmentId])).toEqual([
      ["studio", "env-a"],
      ["home-server", "env-b"],
    ])
  })

  it("keeps one entry when the same machine is paired again at another address", () => {
    setServers([...useConnection.getState().servers, server("c", 1003)])
    socketOf(1003).ready({ id: "env-a", name: "studio" })
    expect(useConnection.getState().servers.map((entry) => entry.id)).toEqual(["b", "c"])
  })

  it("learns a relay from the handshake without dropping the socket or its calls", async () => {
    setServers([...useConnection.getState().servers, server("c", 1003)])
    const creating = call("projects.create", { name: "api", rootPath: "/srv/api", setupScript: null }, { server: "c" })
    const direct = socketOf(1003)
    direct.ready({ id: "env-c", name: "laptop" }, "c.example.com")
    expect(useConnection.getState().servers.find((entry) => entry.id === "c")?.relay).toBe("c.example.com")
    expect(FakeSocket.all.at(-1)).toBe(direct)

    direct.answer("projects.create", project("api"))
    expect((await creating).name).toBe("api")

    vi.useFakeTimers()
    try {
      direct.onclose?.({ code: 1006 })
      reconnectNow("c")
      expect(FakeSocket.all.at(-1)).not.toBe(direct)
      expect(FakeSocket.all.at(-1)?.url).toBe("ws://127.0.0.1:1003/remote")
      vi.advanceTimersByTime(RELAY_DELAY_MS)
      expect(FakeSocket.all.at(-1)?.url).toBe("wss://c.example.com/remote")
    } finally {
      vi.useRealTimers()
    }
  })

  it("moves off the relay to the LAN address the desktop reports, without waiting for the next check", async () => {
    vi.useFakeTimers()
    try {
      const tailscaleOnly = { ...server("c", 1003), hosts: ["100.64.0.2"] as const, relay: "c.example.com" }
      setServers([...useConnection.getState().servers, tailscaleOnly])
      await vi.advanceTimersByTimeAsync(RELAY_DELAY_MS)
      const relay = FakeSocket.all.at(-1)!
      expect(relay.url).toBe("wss://c.example.com/remote")

      relay.ready({ id: "env-c", name: "laptop" }, "c.example.com", ["100.64.0.2", "192.168.1.5"])
      expect(useConnection.getState().servers.find((entry) => entry.id === "c")?.hosts).toEqual([
        "100.64.0.2",
        "192.168.1.5",
      ])
      const check = FakeSocket.all.findLast((socket) => socket.url === "ws://192.168.1.5:1003/remote")!
      expect(check).toBeDefined()

      check.onopen?.()
      expect(check.raw).toEqual([])
      const lan = FakeSocket.all.at(-1)!
      expect(lan.url).toBe("ws://192.168.1.5:1003/remote")
      expect(lan).not.toBe(check)
      lan.ready({ id: "env-c", name: "laptop" }, "c.example.com", ["100.64.0.2", "192.168.1.5"])

      unanswered(call("projects.list", undefined, { server: "c" }))
      await vi.advanceTimersByTimeAsync(0)
      expect(lan.calls("projects.list")).toHaveLength(1)
      expect(relay.calls("projects.list")).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("uses up the pairing secret and keeps the rest of the pairing", () => {
    setServers([...useConnection.getState().servers, { ...server("c", 1003), secret: "one-time" }])
    const socket = socketOf(1003)
    socket.ready({ id: "env-c", name: "laptop" })
    expect(socket.sent[0]).toEqual({ type: "hello", name: "iPhone", secret: "one-time", compactEvents: true })
    expect(storedServers().find((entry) => entry.id === "c")).toMatchObject({ secret: null, key: HOST_KEY })
    expect(FakeSocket.all.at(-1)).toBe(socket)
  })

  it("shows the code for a relay machine, asks whether the machine accepted it, and remembers Yes", () => {
    setServers([{ ...server("c", 1003), verified: false, source: "relay" }])
    const socket = socketOf(1003)
    socket.handshake()
    socket.pend()
    expect(serverState("c")).toMatchObject({ status: "approval", approval: { code: socket.code(), accepted: false } })

    socket.ready({ id: "env-c", name: "laptop" })
    expect(serverState("c")).toMatchObject({ status: "approval", approval: { code: socket.code(), accepted: true } })

    confirmHost("c", true)
    expect(serverState("c")).toMatchObject({ status: "connected", approval: null, verified: true })
    expect(FakeSocket.all.at(-1)).toBe(socket)
  })

  it("never dials a pairing saved before encryption", () => {
    setServers([{ ...server("c", 1003), key: null }])
    expect(FakeSocket.all.filter((socket) => socket.url.includes(":1003/"))).toEqual([])
    expect(useConnection.getState().servers[0]).toMatchObject({ status: "unauthorized", refusal: "predates" })
  })
})
