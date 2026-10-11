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

export interface ListeningProcess extends OpenPort {
  /** Parent pids from the direct parent up to (excluding) init. */
  readonly ancestors: ReadonlyArray<number>
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

/** Reads /proc/<pid>/stat. The command name may contain spaces and parens, so split after the last ")". */
const parentPid = (stat: string): number => Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])

const optional = <A>(promise: Promise<A>): Promise<A | null> => promise.catch(() => null)

const readAncestors = async (fs: ProcFs, pid: number): Promise<Array<number>> => {
  const ancestors: Array<number> = []
  let current = pid
  // Bounded so a pid reused mid-walk cannot loop forever.
  while (ancestors.length < 64) {
    const stat = await optional(fs.readFile(`/proc/${current}/stat`))
    if (stat === null) break
    const parent = parentPid(stat)
    if (!Number.isInteger(parent) || parent <= 1) break
    ancestors.push(parent)
    current = parent
  }
  return ancestors
}

/**
 * Every process that owns a listening TCP socket, one entry per (port, pid).
 * Processes this user cannot inspect are skipped.
 */
export const findListeningPorts = async (fs: ProcFs): Promise<Array<ListeningProcess>> => {
  const tables = await Promise.all(["/proc/net/tcp", "/proc/net/tcp6"].map((path) => optional(fs.readFile(path))))
  const portByInode = new Map(
    tables.flatMap((text) => (text ? parseProcNetTcp(text) : [])).map((s) => [s.inode, s.port]),
  )
  if (portByInode.size === 0) return []

  const pids = (await fs.readdir("/proc")).filter((name) => /^\d+$/.test(name)).map(Number)
  const owners = await Promise.all(
    pids.map(async (pid) => {
      const fds = (await optional(fs.readdir(`/proc/${pid}/fd`))) ?? []
      const links = await Promise.all(fds.map((fd) => optional(fs.readlink(`/proc/${pid}/fd/${fd}`))))
      const ports = new Set(
        links.flatMap((link) => {
          const port = portByInode.get(link?.match(/^socket:\[(\d+)\]$/)?.[1] ?? "")
          return port === undefined ? [] : [port]
        }),
      )
      return { pid, ports }
    }),
  )

  const result = await Promise.all(
    owners
      .filter((owner) => owner.ports.size > 0)
      .map(async ({ pid, ports }) => {
        const [comm, cwd, ancestors] = await Promise.all([
          optional(fs.readFile(`/proc/${pid}/comm`)),
          optional(fs.readlink(`/proc/${pid}/cwd`)),
          readAncestors(fs, pid),
        ])
        const command = comm?.trim() ?? ""
        return [...ports].map((port) => ({ port, pid, command, cwd, ancestors }))
      }),
  )
  return result.flat().toSorted((a, b) => a.port - b.port || a.pid - b.pid)
}

const isInside = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

/**
 * Keeps processes running in `workspacePath` or descending from one of `agentPids`. The agent CLIs
 * and kkcode's own process tree (Electron helpers, the DevTools port) are never the user's servers,
 * so they are left out even when their cwd is the workspace.
 */
export const attributeToWorkspace = (
  processes: ReadonlyArray<ListeningProcess>,
  {
    workspacePath,
    agentPids,
    selfPid,
  }: { readonly workspacePath: string; readonly agentPids: ReadonlySet<number>; readonly selfPid: number },
): Array<OpenPort> =>
  processes
    .filter((proc) => {
      if (proc.pid === selfPid || agentPids.has(proc.pid)) return false
      const underAgent = proc.ancestors.some((pid) => agentPids.has(pid))
      if (underAgent) return true
      if (proc.ancestors.includes(selfPid)) return false
      return proc.cwd !== null && isInside(proc.cwd, workspacePath)
    })
    .map(({ port, pid, command, cwd }) => ({ port, pid, command, cwd }))

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

const make = Effect.gen(function* () {
  const activeWorkspace = yield* makeActiveWorkspace

  const scan = Effect.tryPromise({
    try: () => findListeningPorts(procFs),
    catch: (cause) => new PortsError({ message: `Could not read /proc: ${String(cause)}` }),
  })

  const listForThread = (threadId: string) =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return []
      const workspace = yield* activeWorkspace(threadId)
      const processes = yield* scan
      return attributeToWorkspace(processes, {
        workspacePath: workspace.cwd,
        agentPids: agentPidsByThread.get(threadId) ?? new Set(),
        selfPid: process.pid,
      })
    })

  const kill = (pid: number) =>
    Effect.gen(function* () {
      // Only processes that own a listening socket, so the renderer cannot signal arbitrary pids.
      const processes = yield* scan
      if (!processes.some((proc) => proc.pid === pid)) {
        return yield* new PortsError({ message: `Process ${pid} is not listening on a port` })
      }
      if (!signal(pid, "SIGTERM")) return yield* new PortsError({ message: `Could not stop process ${pid}` })
      yield* Effect.sleep(KILL_GRACE).pipe(
        Effect.andThen(Effect.sync(() => signal(pid, 0) && signal(pid, "SIGKILL"))),
        Effect.forkDetach,
      )
    })

  return Ports.of({ listForThread, kill })
})

export const layer = Layer.effect(Ports, make)
