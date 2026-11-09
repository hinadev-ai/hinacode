import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { afterAll, beforeAll, describe, expect, it, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import {
  belongsToWorkspace,
  listeningSockets,
  parseNetstat,
  parseSs,
  Ports,
  layer as portsLayer,
  socketsFingerprint,
} from "./Ports.ts"

const listenerPids: Array<number> = []

const LISTENER =
  "const s = require('net').createServer().listen(0, '127.0.0.1', () => console.log(process.pid, s.address().port))"

const listenIn = (cwd: string) =>
  Effect.promise(
    () =>
      new Promise<{ port: number; pid: number }>((resolve, reject) => {
        const shell = spawn("sh", ["-c", `"$0" -e "$1" &`, process.execPath, LISTENER], {
          cwd,
          stdio: ["ignore", "pipe", "inherit"],
        })
        shell.once("error", reject)
        shell.stdout.once("data", (chunk) => {
          const [pid = -1, port = -1] = String(chunk).trim().split(" ").map(Number)
          listenerPids.push(pid)
          resolve({ port, pid })
        })
      }),
  )

const HANDOFF_LISTENER = `
const { createServer } = require("node:net")
const { spawn } = require("node:child_process")
const server = createServer().listen(0, "127.0.0.1", () => {
  console.log(process.pid, server.address().port)
  process.on("SIGUSR2", () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "ignore", "ignore", server._handle.fd],
      detached: true,
    })
    child.unref()
    console.log(child.pid)
    setTimeout(() => process.exit(0), 50)
  })
})
`

const listenAndHandOff = (cwd: string) =>
  Effect.promise(() => {
    const parent = spawn("sh", ["-c", `"$0" -e "$1" &`, process.execPath, HANDOFF_LISTENER], {
      cwd,
      stdio: ["ignore", "pipe", "inherit"],
    })
    const lines = createInterface({ input: parent.stdout })[Symbol.asyncIterator]()
    return lines.next().then((first) => {
      const [pid = -1, port = -1] = String(first.value).split(" ").map(Number)
      listenerPids.push(pid)
      const handOff = Effect.promise(async () => {
        process.kill(pid, "SIGUSR2")
        const child = Number((await lines.next()).value)
        listenerPids.push(child)
        await new Promise((resolve) => parent.stdout.once("close", resolve))
        return child
      })
      return { pid, port, handOff }
    })
  })

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const portsOf = (threadId: string, options?: { readonly fresh?: boolean }) =>
  Ports.use((ports) => ports.listForThread(threadId, options)).pipe(
    Effect.map((ports) => ports.map(({ port, pid }) => ({ port, pid }))),
  )

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("Ports.listForThread", () => {
  let base = ""
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "kk-ports-"))
  })
  afterAll(async () => {
    for (const pid of listenerPids.filter(isAlive)) process.kill(pid)
    await rm(base, { recursive: true, force: true })
  })

  layer(portsLayer.pipe(Layer.provideMerge(Db.layer(":memory:")), Layer.provide(NodeServices.layer)))((shared) => {
    shared.effect("lists a project-root listener after the thread's worktree was removed", () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(join(base, "repo-")))
        const listener = yield* listenIn(root)
        const { threadId } = yield* seedThread({
          rootPath: root,
          worktree: { path: join(base, "gone"), baseRef: "main", status: "removed" },
        })
        expect(yield* portsOf(threadId)).toStrictEqual([listener])
      }),
    )

    shared.effect("lists the active worktree's listener and not the project root's", () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(join(base, "repo-")))
        const worktree = yield* Effect.promise(() => mkdtemp(join(base, "worktree-")))
        yield* listenIn(root)
        const listener = yield* listenIn(worktree)
        const { threadId } = yield* seedThread({
          rootPath: root,
          worktree: { path: worktree, baseRef: "main", status: "ready" },
        })
        expect(yield* portsOf(threadId)).toStrictEqual([listener])
      }),
    )

    shared.effect("lists a listener that started after the previous scan", () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(join(base, "repo-")))
        const first = yield* listenIn(root)
        const { threadId } = yield* seedThread({ rootPath: root })
        expect(yield* portsOf(threadId)).toStrictEqual([first])
        const second = yield* listenIn(root)
        expect(yield* portsOf(threadId)).toStrictEqual([first, second].toSorted((a, b) => a.port - b.port))
      }),
    )

    shared.effect.skipIf(process.platform !== "linux")(
      "sees a listener inherited by a child process on a fresh scan",
      () =>
        Effect.gen(function* () {
          const root = yield* Effect.promise(() => mkdtemp(join(base, "repo-")))
          const listener = yield* listenAndHandOff(root)
          const { threadId } = yield* seedThread({ rootPath: root })
          expect(yield* portsOf(threadId)).toStrictEqual([{ port: listener.port, pid: listener.pid }])

          const inherited = yield* listener.handOff

          expect(yield* portsOf(threadId, { fresh: true })).toStrictEqual([{ port: listener.port, pid: inherited }])
        }),
    )
  })
})

const SS = `LISTEN 0      4096   127.0.0.53%lo:53      0.0.0.0:*
LISTEN 0      511        127.0.0.1:5173    0.0.0.0:* users:(("node",pid=30,fd=21))
LISTEN 0      511             [::]:8080       [::]:* users:(("claude",pid=21,fd=40),("my (dev) srv",pid=22,fd=12))
LISTEN 0      128                *:4000          *:* users:(("python3",pid=40,fd=3))
`

describe("parseSs", () => {
  it("reads every process holding each listening socket, across address families", () => {
    expect(parseSs(SS)).toStrictEqual([
      { pid: 30, command: "node", port: 5173 },
      { pid: 21, command: "claude", port: 8080 },
      { pid: 22, command: "my (dev) srv", port: 8080 },
      { pid: 40, command: "python3", port: 4000 },
    ])
  })
})

const PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5230216 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1435 0100007F:A2C4 01 00000000:00000000 00:00000000 00000000  1000        0 5230299 1 0000000000000000 20 4 30 10 -1
   2: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 39232875 1 0000000000000000 100 0 0 10 0
`

describe("listeningSockets", () => {
  it("keys each listening socket by address and inode, skipping connections", () => {
    expect(listeningSockets(PROC_NET_TCP)).toStrictEqual(["0100007F:1435/5230216", "00000000:1F90/39232875"])
  })
})

describe("socketsFingerprint", () => {
  const missing = Object.assign(new Error("no such file"), { code: "ENOENT" })
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" })

  it("is unavailable when a table could not be read for a reason other than ENOENT", () => {
    expect(socketsFingerprint([{ text: PROC_NET_TCP }, { error: denied }])).toBeNull()
  })

  it("treats an absent table as empty and still fingerprints the rest", () => {
    expect(socketsFingerprint([{ text: PROC_NET_TCP }, { error: missing }])).toBe(
      "00000000:1F90/39232875 0100007F:1435/5230216",
    )
    expect(socketsFingerprint([{ error: missing }, { error: missing }])).toBe("")
  })
})

const NETSTAT = `
使用中連線

  協定   本機位址               外部位址               狀態            PID
  TCP    0.0.0.0:22             0.0.0.0:0              LISTENING       3120
  TCP    127.0.0.1:5173         0.0.0.0:0              ABHÖREN         7788
  TCP    10.10.10.50:22         10.10.10.1:50122       ESTABLISHED     3120
  TCP    [::]:8080              [::]:0                 LISTENING       4412
  TCP    [::1]:9235             [::]:0                 LISTENING       4412
`

describe("parseNetstat", () => {
  it("reads listening sockets in any display language, across address families", () => {
    expect(parseNetstat(NETSTAT)).toStrictEqual([
      { pid: 3120, port: 22 },
      { pid: 7788, port: 5173 },
      { pid: 4412, port: 8080 },
      { pid: 4412, port: 9235 },
    ])
  })
})

describe("belongsToWorkspace", () => {
  const SELF = 10
  const AGENT = 20
  const include = belongsToWorkspace({ workspacePath: "/ws", agentPids: new Set([AGENT]), selfPid: SELF })
  const proc = (pid: number, cwd: string | null, ancestors: ReadonlyArray<number>) => ({
    pid,
    command: `cmd ${pid}`,
    cwd,
    ancestors,
  })

  it("keeps the agent's descendants wherever they run, and processes started inside the workspace", () => {
    expect(include(proc(22, "/tmp", [21, AGENT, SELF]))).toBe(true)
    expect(include(proc(30, "/ws/app", []))).toBe(true)
  })

  it("leaves out HinaCode, the agent itself, HinaCode's other children and processes outside the workspace", () => {
    expect(include(proc(SELF, "/ws", []))).toBe(false)
    expect(include(proc(AGENT, "/ws", [SELF]))).toBe(false)
    expect(include(proc(11, "/ws", [SELF]))).toBe(false)
    expect(include(proc(40, "/elsewhere", []))).toBe(false)
    expect(include(proc(41, "/ws-sibling", []))).toBe(false)
    expect(include(proc(42, null, []))).toBe(false)
  })

  it("keeps only the agent's descendants when the thread has no workspace of its own", () => {
    const agentOnly = belongsToWorkspace({ workspacePath: null, agentPids: new Set([AGENT]), selfPid: SELF })
    expect(agentOnly(proc(22, "/tmp", [21, AGENT, SELF]))).toBe(true)
    expect(agentOnly(proc(30, "/ws/app", []))).toBe(false)
  })
})
