import { type ChildProcess, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, afterEach, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vitest"
import { memoryGuard, type MemoryFiles, type MemoryReading, readMemory, readProcesses } from "./memoryGuard.ts"
import { registerAgentPid } from "./services/Ports.ts"

const MIB = 1024 ** 2
const GIB = 1024 ** 3
const root = mkdtempSync(join(tmpdir(), "hinacode-memory-guard-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const pressure = (full: number) =>
  `some avg10=${full} avg60=0.00 avg300=0.00 total=0\nfull avg10=${full} avg60=0.00 avg300=0.00 total=0\n`

const meminfo = (kib: { total: number; available: number; swapTotal?: number; swapFree?: number }) =>
  [
    `MemTotal:       ${kib.total} kB`,
    `MemFree:        ${kib.available} kB`,
    `MemAvailable:   ${kib.available} kB`,
    `SwapTotal:      ${kib.swapTotal ?? 0} kB`,
    `SwapFree:       ${kib.swapFree ?? 0} kB`,
    "",
  ].join("\n")

const machine = (name: string, files: Readonly<Record<string, string>>): MemoryFiles => {
  const dir = join(root, name)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return { proc: join(dir, "proc"), cgroup: join(dir, "cgroup") }
}

describe("readMemory", () => {
  it("reads the host's free memory and swap, and the worst stall on the way up its cgroups", async () => {
    const files = machine("host", {
      "proc/meminfo": meminfo({ total: 16 * MIB, available: 4 * MIB, swapTotal: 8 * MIB, swapFree: 6 * MIB }),
      "proc/pressure/memory": pressure(12.5),
      "proc/self/cgroup": "0::/user.slice/app.slice/hinacode.service\n",
      "cgroup/user.slice/memory.max": "max\n",
      "cgroup/user.slice/memory.pressure": pressure(3),
      "cgroup/user.slice/app.slice/memory.pressure": pressure(41.2),
      "cgroup/user.slice/app.slice/hinacode.service/memory.pressure": pressure(20),
    })

    expect(await readMemory(files)).toStrictEqual({
      stalledPercent: 41.2,
      freeBytes: 10 * GIB,
      capacityBytes: 24 * GIB,
    })
  })

  it("reads the room under a cgroup limit that allows no swap", async () => {
    const files = machine("limited", {
      "proc/meminfo": meminfo({ total: 16 * MIB, available: 12 * MIB, swapTotal: 8 * MIB, swapFree: 8 * MIB }),
      "proc/pressure/memory": pressure(0),
      "proc/self/cgroup": "0::/user.slice/hinacode.service\n",
      "cgroup/user.slice/memory.max": `${8 * GIB}\n`,
      "cgroup/user.slice/memory.current": `${7.5 * GIB}\n`,
      "cgroup/user.slice/memory.stat": `anon ${7 * GIB}\ninactive_file ${96 * MIB}\nactive_file ${32 * MIB}\n`,
      "cgroup/user.slice/memory.swap.max": "0\n",
      "cgroup/user.slice/memory.swap.current": "0\n",
    })

    expect(await readMemory(files)).toStrictEqual({ stalledPercent: 0, freeBytes: 0.625 * GIB, capacityBytes: 8 * GIB })
  })

  it("lets a limited cgroup use the host's swap when its own swap is unlimited", async () => {
    const files = machine("container", {
      "proc/meminfo": meminfo({ total: 64 * MIB, available: 48 * MIB, swapTotal: 2 * MIB, swapFree: 1 * MIB }),
      "proc/self/cgroup": "0::/\n",
      "cgroup/memory.max": `${4 * GIB}\n`,
      "cgroup/memory.current": `${3.5 * GIB}\n`,
      "cgroup/memory.stat": "inactive_file 0\nactive_file 0\n",
      "cgroup/memory.swap.max": "max\n",
      "cgroup/memory.pressure": pressure(55),
    })

    expect(await readMemory(files)).toStrictEqual({ stalledPercent: 55, freeBytes: 1.5 * GIB, capacityBytes: 6 * GIB })
  })
})

interface Agent {
  readonly process: ChildProcess
  readonly toolPid: number
  readonly toolExit: Promise<string>
}

const toolScript = (bytes: number) =>
  `const held = Buffer.alloc(${bytes}, 1); process.stdout.write("ready\\n"); setInterval(() => held[0]++, 1000)`

const agentScript = (bytes: number) => `
  const tool = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(toolScript(bytes))}], {
    stdio: ["ignore", "pipe", "ignore"],
  })
  tool.stdout.once("data", () => process.stdout.write("tool " + tool.pid + "\\n"))
  tool.once("exit", (code, signal) => process.stdout.write("exit " + signal + "\\n"))
  setInterval(() => {}, 1000)
`

const signal = (pid: number | undefined, name: NodeJS.Signals | 0) => {
  try {
    return pid !== undefined && process.kill(pid, name)
  } catch {
    return false
  }
}

const running: Array<ChildProcess> = []
afterEach(() => {
  for (const agent of running.splice(0)) signal(agent.pid === undefined ? undefined : -agent.pid, "SIGKILL")
})

const startAgent = (toolBytes: number) =>
  new Promise<Agent>((resolve) => {
    const agent = spawn(process.execPath, ["-e", agentScript(toolBytes)], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    })
    running.push(agent)
    const lines = (prefix: string) =>
      new Promise<string>((found) => {
        agent.stdout.on("data", (chunk: Buffer) => {
          const line = String(chunk)
            .split("\n")
            .find((text) => text.startsWith(prefix))
          if (line !== undefined) found(line.slice(prefix.length))
        })
      })
    const toolExit = lines("exit ")
    void lines("tool ").then((pid) => resolve({ process: agent, toolPid: Number(pid), toolExit }))
  })

const isAlive = (pid: number | undefined) => signal(pid, 0)

const guarded = (reading: MemoryReading, abort: (threadId: string) => Effect.Effect<void> = () => Effect.void) => {
  const state = { reading, reads: 0, aborted: [] as Array<{ readonly threadId: string; readonly message: string }> }
  const guard = memoryGuard(
    {
      isBusy: () => Effect.succeed(true),
      abort: (threadId, message) =>
        Effect.andThen(
          Effect.sync(() => void state.aborted.push({ threadId, message })),
          abort(threadId),
        ),
    },
    Effect.sync(() => {
      state.reads++
      return state.reading
    }),
  )
  const untilRead = (count: number) =>
    TestClock.adjust("1 second").pipe(
      Effect.andThen(Effect.promise(readProcesses)),
      Effect.repeat({ until: () => state.reads >= count }),
    )
  return { state, guard, untilRead }
}

describe.runIf(process.platform === "linux")("memoryGuard", () => {
  it.effect("kills the tools of the thread that holds the most and aborts its turn with the reason", () =>
    Effect.gen(function* () {
      const [light, heavy] = yield* Effect.promise(() => Promise.all([startAgent(48 * MIB), startAgent(160 * MIB)]))
      const unregister = [
        registerAgentPid("light", () => light!.process.pid),
        registerAgentPid("heavy", () => heavy!.process.pid),
      ]
      const short = { stalledPercent: 0, freeBytes: 20 * MIB, capacityBytes: 512 * MIB }
      const { state, guard, untilRead } = guarded(short, (threadId) =>
        threadId === "heavy" ? Effect.never : Effect.void,
      )

      yield* guard
      yield* untilRead(1)
      yield* Effect.promise(() => vi.waitFor(() => expect(state.aborted).toHaveLength(1), { timeout: 10_000 }))

      expect(state.aborted[0]?.threadId).toBe("heavy")
      expect(state.aborted[0]?.message).toMatch(
        /^Stopped to free memory\. This machine was about to run out, and this thread's processes held the most: \d+ MB\. The largest was `node -e const held = Buffer\.alloc\(167772160, 1\); .+…` at \d+ MB\.$/,
      )
      expect(yield* Effect.promise(() => heavy!.toolExit)).toBe("SIGKILL")
      expect({ heavyAgent: isAlive(heavy!.process.pid), lightTool: isAlive(light!.toolPid) }).toStrictEqual({
        heavyAgent: true,
        lightTool: true,
      })

      yield* untilRead(2)
      yield* Effect.promise(() => vi.waitFor(() => expect(state.aborted).toHaveLength(2), { timeout: 10_000 }))
      expect(state.aborted[1]?.threadId).toBe("light")
      expect(yield* Effect.promise(() => light!.toolExit)).toBe("SIGKILL")
      for (const release of unregister) release()
    }).pipe(Effect.scoped),
  )

  it.effect("stands down when the agents hold less than the reserve it wants back", () =>
    Effect.gen(function* () {
      const agent = yield* Effect.promise(() => startAgent(8 * MIB))
      const unregister = registerAgentPid("small", () => agent.process.pid)
      const { state, guard, untilRead } = guarded({ stalledPercent: 0, freeBytes: 100 * MIB, capacityBytes: 64 * GIB })

      yield* guard
      yield* untilRead(3)

      expect(state.aborted).toStrictEqual([])
      expect(isAlive(agent.toolPid)).toBe(true)
      unregister()
    }).pipe(Effect.scoped),
  )

  it.effect("leaves every thread alone while memory is roomy", () =>
    Effect.gen(function* () {
      const agent = yield* Effect.promise(() => startAgent(8 * MIB))
      const unregister = registerAgentPid("calm", () => agent.process.pid)
      const { state, guard, untilRead } = guarded({ stalledPercent: 39, freeBytes: 8 * GIB, capacityBytes: 16 * GIB })

      yield* guard
      yield* untilRead(3)

      expect(state.aborted).toStrictEqual([])
      expect(isAlive(agent.toolPid)).toBe(true)
      unregister()
    }).pipe(Effect.scoped),
  )
})
