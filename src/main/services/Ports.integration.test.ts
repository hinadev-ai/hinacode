import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import { belongsToWorkspace, parseNetstat, parseSs, Ports, layer as portsLayer } from "./Ports.ts"

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

const portsOf = (threadId: string) =>
  Ports.use((ports) => ports.listForThread(threadId)).pipe(
    Effect.map((ports) => ports.map(({ port, pid }) => ({ port, pid }))),
  )

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("Ports.listForThread", () => {
  let base = ""
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "kk-ports-"))
  })
  afterAll(async () => {
    for (const pid of listenerPids) process.kill(pid)
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
})
