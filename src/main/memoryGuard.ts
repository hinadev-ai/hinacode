import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { Clock, Effect, Layer, Schedule } from "effect"
import { threadOfSession } from "./agents/provider.ts"
import { AgentRunner } from "./services/AgentRunner.ts"
import { agentPidsBySession } from "./services/Ports.ts"

const GIB = 1024 ** 3
const MIB = 1024 ** 2
export const STALL_LIMIT_PERCENT = 40
export const STALL_HOLD_MS = 10_000
const CHECK_INTERVAL = "1 second"
const REST_AFTER_NOTHING_TO_SHED_MS = 30_000
const COMMAND_CHARS = 80
const PROC = "/proc"

export interface MemoryFiles {
  readonly proc: string
  readonly cgroup: string
}

const linuxMemoryFiles: MemoryFiles = { proc: PROC, cgroup: "/sys/fs/cgroup" }

interface Room {
  readonly freeBytes: number
  readonly capacityBytes: number
}

export interface MemoryReading extends Room {
  readonly stalledPercent: number
}

export interface ProcessUsage {
  readonly pid: number
  readonly parent: number
  readonly bytes: number
}

export interface ThreadMemory {
  readonly threadId: string
  readonly bytes: number
  readonly tools: ReadonlyArray<ProcessUsage>
}

const textOf = (path: string) => readFile(path, "utf8").catch(() => "")

const kilobytes = (text: string, key: string) =>
  Number(new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text)?.[1] ?? 0) * 1024

const counter = (text: string, key: string) => Number(new RegExp(`^${key} (\\d+)`, "m").exec(text)?.[1] ?? 0)

const limitOf = (text: string) => (text.trim() === "" || text.trim() === "max" ? Infinity : Number(text))

const fullStallPercent = (pressure: string) => Number(/^full avg10=([\d.]+)/m.exec(pressure)?.[1] ?? 0)

const reserveBytes = (capacityBytes: number) => Math.min(GIB, capacityBytes / 10)

const tightness = (room: Room) => room.freeBytes / reserveBytes(room.capacityBytes)

const cgroupDirs = (ownCgroup: string, root: string) => {
  const parts = (/^0::(.*)$/m.exec(ownCgroup)?.[1] ?? "").split("/").filter((part) => part !== "")
  return [root, ...parts.map((_, depth) => join(root, ...parts.slice(0, depth + 1)))]
}

const hostRoom = (meminfo: string): Room => ({
  freeBytes: kilobytes(meminfo, "MemAvailable") + kilobytes(meminfo, "SwapFree"),
  capacityBytes: kilobytes(meminfo, "MemTotal") + kilobytes(meminfo, "SwapTotal"),
})

const limitedRoom = async (dir: string, meminfo: string): Promise<ReadonlyArray<Room>> => {
  const max = limitOf(await textOf(join(dir, "memory.max")))
  if (max === Infinity) return []
  const [current, stat, swapLimit, swapCurrent] = await Promise.all([
    textOf(join(dir, "memory.current")),
    textOf(join(dir, "memory.stat")),
    textOf(join(dir, "memory.swap.max")),
    textOf(join(dir, "memory.swap.current")),
  ])
  const reclaimableCache = counter(stat, "inactive_file") + counter(stat, "active_file")
  const swapMax = limitOf(swapLimit)
  const sharesHostSwap = swapMax === Infinity
  return [
    {
      freeBytes:
        Math.max(0, max - Number(current) + reclaimableCache) +
        (sharesHostSwap ? kilobytes(meminfo, "SwapFree") : Math.max(0, swapMax - Number(swapCurrent))),
      capacityBytes: max + (sharesHostSwap ? kilobytes(meminfo, "SwapTotal") : swapMax),
    },
  ]
}

export const readMemory = async ({ proc, cgroup }: MemoryFiles): Promise<MemoryReading> => {
  const [meminfo, systemPressure, ownCgroup] = await Promise.all([
    textOf(join(proc, "meminfo")),
    textOf(join(proc, "pressure/memory")),
    textOf(join(proc, "self/cgroup")),
  ])
  const dirs = cgroupDirs(ownCgroup, cgroup)
  const [pressures, limited] = await Promise.all([
    Promise.all(dirs.map((dir) => textOf(join(dir, "memory.pressure")))),
    Promise.all(dirs.map((dir) => limitedRoom(dir, meminfo))),
  ])
  const tightest = limited
    .flat()
    .reduce((worst, room) => (tightness(room) < tightness(worst) ? room : worst), hostRoom(meminfo))
  return { stalledPercent: Math.max(...[systemPressure, ...pressures].map(fullStallPercent)), ...tightest }
}

const statusField = (status: string, key: string) =>
  Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(status)?.[1] ?? 0)

export const readProcesses = async (): Promise<ReadonlyArray<ProcessUsage>> => {
  const pids = (await readdir(PROC)).filter((name) => /^\d+$/.test(name))
  const statuses = await Promise.all(pids.map((pid) => textOf(join(PROC, pid, "status"))))
  return statuses.flatMap((status, index) =>
    status === ""
      ? []
      : [
          {
            pid: Number(pids[index]),
            parent: statusField(status, "PPid"),
            bytes: (statusField(status, "VmRSS") + statusField(status, "VmSwap")) * 1024,
          },
        ],
  )
}

const commandOf = async (pid: number) => {
  const [executable = "", ...args] = (await textOf(join(PROC, String(pid), "cmdline"))).split("\0")
  const command = [basename(executable), ...args].join(" ").replaceAll("`", "'").replaceAll(/\s+/g, " ").trim()
  return command.length > COMMAND_CHARS ? `${command.slice(0, COMMAND_CHARS)}…` : command
}

const totalBytes = (holders: ReadonlyArray<{ readonly bytes: number } | undefined>) =>
  holders.reduce((sum, holder) => sum + (holder?.bytes ?? 0), 0)

export const memoryByThread = (
  processes: ReadonlyArray<ProcessUsage>,
  agents: ReadonlyMap<string, ReadonlySet<number>>,
): ReadonlyArray<ThreadMemory> => {
  const byPid = new Map(processes.map((process) => [process.pid, process]))
  const children = new Map<number, Array<ProcessUsage>>()
  for (const process of processes) children.set(process.parent, [...(children.get(process.parent) ?? []), process])

  const toolsUnder = (agentPids: ReadonlySet<number>) => {
    const tools = new Map<number, ProcessUsage>()
    const unvisited = [...agentPids]
    for (let pid = unvisited.pop(); pid !== undefined; pid = unvisited.pop()) {
      for (const child of children.get(pid) ?? []) {
        if (tools.has(child.pid) || agentPids.has(child.pid)) continue
        tools.set(child.pid, child)
        unvisited.push(child.pid)
      }
    }
    return [...tools.values()].toSorted((a, b) => b.bytes - a.bytes)
  }

  return [...agents]
    .map(([threadId, agentPids]) => {
      const tools = toolsUnder(agentPids)
      return { threadId, bytes: totalBytes([...agentPids].map((pid) => byPid.get(pid))) + totalBytes(tools), tools }
    })
    .toSorted((a, b) => b.bytes - a.bytes)
}

export const judge = (
  stalledSince: number | null,
  reading: MemoryReading,
  now: number,
): { readonly stalledSince: number | null; readonly shed: boolean } => {
  const since = reading.stalledPercent >= STALL_LIMIT_PERCENT ? (stalledSince ?? now) : null
  if (reading.freeBytes < reserveBytes(reading.capacityBytes)) return { stalledSince: since, shed: true }
  if (since === null || now - since < STALL_HOLD_MS) return { stalledSince: since, shed: false }
  return { stalledSince: now, shed: true }
}

export const heaviestWorthShedding = (
  threads: ReadonlyArray<ThreadMemory>,
  capacityBytes: number,
): ThreadMemory | undefined => (totalBytes(threads) >= reserveBytes(capacityBytes) ? threads[0] : undefined)

const size = (bytes: number) =>
  bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / MIB))} MB`

export const shedMessage = (memory: ThreadMemory, largestCommand: string) => {
  const largest = memory.tools[0]
  const held = `Stopped to free memory. This machine was about to run out, and this thread's processes held the most: ${size(memory.bytes)}.`
  return largest === undefined || largestCommand === ""
    ? held
    : `${held} The largest was \`${largestCommand}\` at ${size(largest.bytes)}.`
}

const kill = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL")
    return true
  } catch {
    return false
  }
}

export const memoryGuard = (
  runner: Pick<typeof AgentRunner.Service, "isBusy" | "abort">,
  read: Effect.Effect<MemoryReading>,
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const shedding = new Set<string>()
    let stalledSince: number | null = null
    let restUntil = 0

    const runningAgents = Effect.gen(function* () {
      const byThread = new Map<string, Set<number>>()
      for (const [sessionId, pids] of agentPidsBySession()) {
        const threadId = threadOfSession(sessionId)
        if (shedding.has(threadId) || !(yield* runner.isBusy(threadId))) continue
        byThread.set(threadId, new Set([...(byThread.get(threadId) ?? []), ...pids]))
      }
      return byThread
    })

    const shedHeaviest = (reading: MemoryReading) =>
      Effect.gen(function* () {
        const agents = yield* runningAgents
        if (agents.size === 0) return false
        const threads = memoryByThread(yield* Effect.promise(readProcesses), agents)
        const victim = heaviestWorthShedding(threads, reading.capacityBytes)
        if (victim === undefined) return false
        const [largest] = victim.tools
        const message = shedMessage(
          victim,
          largest === undefined ? "" : yield* Effect.promise(() => commandOf(largest.pid)),
        )
        for (const tool of victim.tools) kill(tool.pid)
        shedding.add(victim.threadId)
        yield* runner
          .abort(victim.threadId, message)
          .pipe(Effect.ensuring(Effect.sync(() => shedding.delete(victim.threadId))), Effect.forkIn(scope))
        yield* Effect.logWarning(
          `memory guard stopped thread ${victim.threadId} holding ${size(victim.bytes)}: ` +
            `${size(reading.freeBytes)} of ${size(reading.capacityBytes)} free, ${reading.stalledPercent}% stalled`,
        )
        return true
      })

    const check = Effect.gen(function* () {
      const reading = yield* read
      const now = yield* Clock.currentTimeMillis
      const verdict = judge(stalledSince, reading, now)
      stalledSince = verdict.stalledSince
      if (!verdict.shed || now < restUntil) return
      if (!(yield* shedHeaviest(reading))) restUntil = now + REST_AFTER_NOTHING_TO_SHED_MS
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("memory guard check failed", cause)))

    yield* Effect.schedule(check, Schedule.spaced(CHECK_INTERVAL)).pipe(Effect.forkScoped)
  })

export const memoryGuardLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (process.platform !== "linux") return
    yield* memoryGuard(
      yield* AgentRunner,
      Effect.promise(() => readMemory(linuxMemoryFiles)),
    )
  }),
)
