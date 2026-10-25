import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { StoredServer } from "./stored-target"

/** A server's socket, answered by hand. */
class FakeSocket {
  static all: FakeSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((message: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  readonly sent: { type: string; id?: number; method?: string; payload?: unknown }[] = []

  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {}

  ready(environment?: { id: string; name: string }, relay?: string) {
    this.onopen?.()
    this.receive({ type: "ready", version: 1, features: ["call-keys"], ...(environment && { environment }), relay })
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  calls(method: string) {
    return this.sent.filter((frame) => frame.type === "call" && frame.method === method)
  }
  answer(method: string, result: unknown) {
    for (const call of this.calls(method)) this.receive({ type: "result", id: call.id, envelope: { result } })
  }
}

vi.stubGlobal("WebSocket", FakeSocket)

const { call, reconnectNow, setServers, useConnection } = await import("./connection")

const server = (id: string, port: number): StoredServer => ({
  id,
  name: null,
  environmentId: null,
  hosts: ["127.0.0.1"],
  port,
  token: "t",
  relay: null,
})

const socketOf = (port: number) => FakeSocket.all.findLast((socket) => socket.url.includes(`:${port}/`))!

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
  queue: [],
  createdBy: "user",
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
})

/** A call the test never answers, which fails when the servers are closed after it. */
const unanswered = (promise: Promise<unknown>) => void promise.catch(() => {})

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

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

  it("sends a named call to the server it names", async () => {
    unanswered(call("projects.create", { name: "api", rootPath: "/srv/api", setupScript: null }, { server: "b" }))
    await flush()
    expect(socketOf(1001).calls("projects.create")).toHaveLength(0)
    expect(socketOf(1002).calls("projects.create")).toHaveLength(1)
  })
})

describe("servers", () => {
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

  it("dials the relay before the hosts", () => {
    setServers([...useConnection.getState().servers, { ...server("c", 1003), relay: "c.example.com" }])
    expect(FakeSocket.all.at(-1)?.url).toBe("wss://c.example.com/remote")
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

    // The next dial starts from the host that worked, then moves on to the relay.
    direct.onclose?.({ code: 1006 })
    reconnectNow("c")
    expect(FakeSocket.all.at(-1)).not.toBe(direct)
    expect(FakeSocket.all.at(-1)?.url).toBe("ws://127.0.0.1:1003/remote")
    FakeSocket.all.at(-1)?.onclose?.({ code: 1006 })
    reconnectNow("c")
    expect(FakeSocket.all.at(-1)?.url).toBe("wss://c.example.com/remote")
  })
})
