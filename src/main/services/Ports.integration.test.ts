import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as Db from "../db/client.ts"
import { seedThread } from "../db/testing.ts"
import { belongsToWorkspace, findListeningPorts, Ports, type ProcFs, layer as portsLayer } from "./Ports.ts"

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

  layer(portsLayer.pipe(Layer.provideMerge(Db.layer(":memory:"))))((shared) => {
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

interface FakeProcess {
  readonly parent: number
  readonly cwd?: string
  readonly fds?: Record<string, string>
  readonly exited?: boolean
}

const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1
   1: 0100007F:0FA0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1
   2: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 333 1
`

const missing = (path: string) => Promise.reject(Object.assign(new Error(path), { code: "ENOENT" }))

const fakeProc = (processes: Record<number, FakeProcess>) => {
  const fdReads: Array<number> = []
  const fs: ProcFs = {
    readFile: (path) => {
      if (path === "/proc/net/tcp") return Promise.resolve(TCP)
      const pid = Number(path.split("/")[2])
      const proc = processes[pid]
      if (!proc || proc.exited || !path.endsWith("/stat")) return missing(path)
      return Promise.resolve(`${pid} (cmd ${pid}) S ${proc.parent} 1 1`)
    },
    readdir: (path) => {
      if (path === "/proc") return Promise.resolve(Object.keys(processes))
      const pid = Number(path.split("/")[2])
      fdReads.push(pid)
      const fds = processes[pid]?.fds
      return fds ? Promise.resolve(Object.keys(fds)) : Promise.reject(new Error("EACCES"))
    },
    readlink: (path) => {
      const [, , pid, kind, fd] = path.split("/")
      const proc = processes[Number(pid)]
      const target = kind === "cwd" ? proc?.cwd : proc?.fds?.[fd ?? ""]
      return target === undefined ? missing(path) : Promise.resolve(target)
    },
  }
  return { fs, fdReads }
}

describe("findListeningPorts", () => {
  const SELF = 10
  const AGENT = 20
  const { fs, fdReads } = fakeProc({
    [SELF]: { parent: 1, cwd: "/ws", fds: { 0: "socket:[999]" } },
    11: { parent: SELF, cwd: "/ws", fds: { 3: "socket:[111]" } },
    [AGENT]: { parent: SELF, cwd: "/ws", fds: { 3: "socket:[111]" } },
    21: { parent: AGENT, cwd: "/tmp", fds: {} },
    22: { parent: 21, cwd: "/tmp", fds: { 4: "socket:[222]", 5: "/dev/null" } },
    30: { parent: 1, cwd: "/ws/app", fds: { 3: "socket:[333]", 4: "socket:[333]" } },
    31: { parent: 1, cwd: "/ws/denied" },
    32: { parent: 1, cwd: "/ws/exited", fds: { 3: "socket:[111]" }, exited: true },
    40: { parent: 1, cwd: "/elsewhere", fds: { 3: "socket:[111]" } },
    41: { parent: 1, cwd: "/ws-sibling", fds: { 3: "socket:[111]" } },
  })

  it.effect("attributes by cwd and agent ancestry and reads only candidates' descriptors", () =>
    Effect.gen(function* () {
      const found = yield* findListeningPorts(
        fs,
        belongsToWorkspace({ workspacePath: "/ws", agentPids: new Set([AGENT]), selfPid: SELF }),
      )
      expect(found).toStrictEqual([
        { pid: 22, command: "cmd 22", cwd: "/tmp", ancestors: [21, AGENT, SELF], port: 4000 },
        { pid: 30, command: "cmd 30", cwd: "/ws/app", ancestors: [], port: 8080 },
      ])
      expect(fdReads.toSorted()).toStrictEqual([21, 22, 30, 31])
    }),
  )
})
