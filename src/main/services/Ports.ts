import { readdir, readFile, readlink } from "node:fs/promises"
import { sep } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import type { OpenPort } from "../../shared/domain.ts"
import type { NotFoundError, PersistenceError } from "./errors.ts"
import { makeActiveWorkspace } from "./workspace.ts"

export class PortsError extends Schema.TaggedError<PortsError>()("PortsError", {
  message: Schema.String,
}) {}

/** The slice of the filesystem the /proc scanner needs, injectable for tests. */
export interface ProcFs {
  readonly readFile: (path: string) => Promise<string>
  readonly readdir: (path: string) => Promise<ReadonlyArray<string>>
  readonly readlink: (path: string) => Promise<string>
}

/** A live process before its file descriptors are read. */
export interface ProcessInfo {
  readonly pid: number
  readonly command: string
  readonly cwd: string | null
  /** Parent pids from the direct parent up to (excluding) init. */
  readonly ancestors: ReadonlyArray<number>
}

export interface ListeningProcess extends ProcessInfo {
  readonly port: number
}

const TCP_LISTEN = "0A"

/** Listening sockets from the text of /proc/net/tcp or /proc/net/tcp6. */
export const parseProcNetTcp = (text: string): Array<{ port: number; inode: string }> =>
  text
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields[3] === TCP_LISTEN && fields[9] !== undefined && fields[9] !== "0")
    .map((fields) => ({
      port: Number.parseInt(fields[1]?.split(":")[1] ?? "", 16),
      inode: fields[9] ?? "",
    }))
    .filter((socket) => Number.isInteger(socket.port))

// /proc/<pid>/stat is "<pid> (<comm>) <state> <ppid> ...". The command name may contain spaces and
// parens, so it ends at the last ")".
const commandOf = (stat: string) => stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"))
const parentPidOf = (stat: string) => Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])

const SCAN_CONCURRENCY = 32
const MAX_ANCESTORS = 64

/** Resolves to null when the file is gone or unreadable: processes exit mid-scan or belong to other users. */
const optional = <A>(read: () => Promise<A>) => Effect.tryPromise(read).pipe(Effect.orElseSucceed(() => null))

const readProcesses = (fs: ProcFs) =>
  Effect.gen(function* () {
    const names = yield* Effect.tryPromise({
      try: () => fs.readdir("/proc"),
      catch: (cause) => new PortsError({ message: `Could not read /proc: ${String(cause)}` }),
    })
    const pids = names.filter((name) => /^\d+$/.test(name)).map(Number)
    const stats = yield* Effect.forEach(
      pids,
      (pid) =>
        Effect.all({
          stat: optional(() => fs.readFile(`/proc/${pid}/stat`)),
          cwd: optional(() => fs.readlink(`/proc/${pid}/cwd`)),
        }).pipe(Effect.map((read) => ({ pid, ...read }))),
      { concurrency: SCAN_CONCURRENCY },
    )
    const live = stats.flatMap(({ pid, stat, cwd }) => (stat === null ? [] : [{ pid, stat, cwd }]))
    const parentOf = new Map(live.map(({ pid, stat }) => [pid, parentPidOf(stat)]))
    const ancestorsOf = (pid: number) => {
      const ancestors: Array<number> = []
      // Bounded so a pid reused between reads cannot form a cycle.
      for (let parent = parentOf.get(pid); ancestors.length < MAX_ANCESTORS; parent = parentOf.get(parent)) {
        if (parent === undefined || !Number.isInteger(parent) || parent <= 1) break
        ancestors.push(parent)
      }
      return ancestors
    }
    return live.map(({ pid, stat, cwd }): ProcessInfo => ({
      pid,
      command: commandOf(stat),
      cwd,
      ancestors: ancestorsOf(pid),
    }))
  })

/**
 * Every process passing `include` that owns a listening TCP socket, one entry per (port, pid). Only the
 * included processes' file descriptors are read, so the cost follows the process count, not the host's
 * descriptor count. Processes this user cannot inspect are skipped.
 */
export const findListeningPorts = (fs: ProcFs, include: (process: ProcessInfo) => boolean) =>
  Effect.gen(function* () {
    const tables = yield* Effect.forEach(["/proc/net/tcp", "/proc/net/tcp6"], (path) =>
      optional(() => fs.readFile(path)),
    )
    const portByInode = new Map(
      tables.flatMap((text) => (text ? parseProcNetTcp(text) : [])).map((s) => [s.inode, s.port]),
    )
    if (portByInode.size === 0) return []

    const candidates = (yield* readProcesses(fs)).filter(include)
    const descriptors = yield* Effect.forEach(
      candidates,
      (proc) =>
        optional(() => fs.readdir(`/proc/${proc.pid}/fd`)).pipe(
          Effect.map((fds) => (fds ?? []).map((fd) => ({ proc, fd }))),
        ),
      { concurrency: SCAN_CONCURRENCY },
    )
    const sockets = yield* Effect.forEach(
      descriptors.flat(),
      ({ proc, fd }) =>
        optional(() => fs.readlink(`/proc/${proc.pid}/fd/${fd}`)).pipe(
          Effect.map((link) => {
            const port = portByInode.get(link?.match(/^socket:\[(\d+)\]$/)?.[1] ?? "")
            return port === undefined ? [] : [{ ...proc, port }]
          }),
        ),
      { concurrency: SCAN_CONCURRENCY },
    )
    const unique = new Map(sockets.flat().map((entry) => [`${entry.port}:${entry.pid}`, entry]))
    return [...unique.values()].toSorted((a, b) => a.port - b.port || a.pid - b.pid)
  })

const isInside = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

/**
 * Whether a process runs in `workspacePath` or descends from one of `agentPids`. The agent CLIs and
 * kkcode's own process tree (Electron helpers, the DevTools port) are never the user's servers, so they
 * are left out even when their cwd is the workspace.
 */
export const belongsToWorkspace =
  ({
    workspacePath,
    agentPids,
    selfPid,
  }: {
    readonly workspacePath: string
    readonly agentPids: ReadonlySet<number>
    readonly selfPid: number
  }) =>
  (proc: ProcessInfo): boolean => {
    if (proc.pid === selfPid || agentPids.has(proc.pid)) return false
    if (proc.ancestors.some((pid) => agentPids.has(pid))) return true
    if (proc.ancestors.includes(selfPid)) return false
    return proc.cwd !== null && isInside(proc.cwd, workspacePath)
  }

const agentPidsByThread = new Map<string, Set<number>>()

/**
 * Marks `pid` as an agent process of `threadId`, so ports opened by its descendants count for the
 * thread even outside the workspace. Returns a function that removes the registration.
 */
export const registerAgentPid = (threadId: string, pid: number): (() => void) => {
  const pids = agentPidsByThread.get(threadId) ?? new Set()
  pids.add(pid)
  agentPidsByThread.set(threadId, pids)
  return () => {
    pids.delete(pid)
    if (pids.size === 0) agentPidsByThread.delete(threadId)
  }
}

const procFs: ProcFs = {
  readFile: (path) => readFile(path, "utf8"),
  readdir: (path) => readdir(path),
  readlink: (path) => readlink(path),
}

const KILL_GRACE = "3 seconds"

/** Returns false when the process is gone (or never was ours to signal). */
const signal = (pid: number, name: NodeJS.Signals | 0) => {
  try {
    process.kill(pid, name)
    return true
  } catch {
    return false
  }
}

export class Ports extends Context.Service<
  Ports,
  {
    readonly listForThread: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<OpenPort>, PersistenceError | NotFoundError | PortsError>
    /** SIGTERM now, SIGKILL after a grace period if the process is still alive. */
    readonly kill: (pid: number) => Effect.Effect<void, PortsError>
  }
>()("kkcode/Ports") {}

const kill = (pid: number) =>
  Effect.gen(function* () {
    // Only processes that own a listening socket, so the renderer cannot signal arbitrary pids.
    const listening = yield* findListeningPorts(procFs, (proc) => proc.pid === pid)
    if (listening.length === 0) {
      return yield* new PortsError({ message: `Process ${pid} is not listening on a port` })
    }
    if (!signal(pid, "SIGTERM")) return yield* new PortsError({ message: `Could not stop process ${pid}` })
    yield* Effect.sleep(KILL_GRACE).pipe(
      Effect.andThen(Effect.sync(() => signal(pid, 0) && signal(pid, "SIGKILL"))),
      Effect.forkDetach,
    )
  })

const make = Effect.gen(function* () {
  const activeWorkspace = yield* makeActiveWorkspace

  const listForThread = (threadId: string) =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return []
      const workspace = yield* activeWorkspace(threadId)
      const listening = yield* findListeningPorts(
        procFs,
        belongsToWorkspace({
          workspacePath: workspace.cwd,
          agentPids: agentPidsByThread.get(threadId) ?? new Set(),
          selfPid: process.pid,
        }),
      )
      return listening.map(({ port, pid, command, cwd }): OpenPort => ({ port, pid, command, cwd }))
    })

  return Ports.of({ listForThread, kill })
})

export const layer = Layer.effect(Ports, make)
