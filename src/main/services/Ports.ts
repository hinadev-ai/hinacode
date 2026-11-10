import { execFile } from "node:child_process"
import { readFile, readlink, realpath } from "node:fs/promises"
import { sep } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import type { OpenPort } from "../../shared/domain.ts"
import type { FolderMissingError, NotFoundError, PersistenceError } from "./errors.ts"
import { makeActiveWorkspace } from "./workspace.ts"

export class PortsError extends Schema.TaggedError<PortsError>()("PortsError", {
  message: Schema.String,
}) {}

export interface ProcessInfo {
  readonly pid: number
  readonly command: string
  readonly cwd: string | null
  readonly ancestors: ReadonlyArray<number>
}

export interface ListeningProcess extends ProcessInfo {
  readonly port: number
}

interface Listener {
  readonly pid: number
  readonly command: string
  readonly port: number
}

type ListeningScanner = (
  include: (process: ProcessInfo) => boolean,
  fresh: boolean,
) => Effect.Effect<ReadonlyArray<ListeningProcess>, PortsError>

const MAX_ANCESTORS = 64

const ancestorsIn = (parentOf: ReadonlyMap<number, number>) => (pid: number) => {
  const ancestors: Array<number> = []
  for (let parent = parentOf.get(pid); ancestors.length < MAX_ANCESTORS; parent = parentOf.get(parent)) {
    if (parent === undefined || !Number.isInteger(parent) || parent <= 1) break
    ancestors.push(parent)
  }
  return ancestors
}

const uniqueByPortAndPid = (entries: ReadonlyArray<ListeningProcess>) =>
  [...new Map(entries.map((entry) => [`${entry.port}:${entry.pid}`, entry])).values()].toSorted(
    (a, b) => a.port - b.port || a.pid - b.pid,
  )

// FIXME: lsof exits 1 when it cannot read one of the requested pids, and still prints the rest
const exec = (file: string, args: ReadonlyArray<string>) =>
  Effect.callback<string, PortsError>((resume) => {
    execFile(file, args, { timeout: 10_000, killSignal: "SIGKILL" }, (error, stdout) =>
      resume(
        error && typeof error.code !== "number"
          ? Effect.fail(new PortsError({ message: `Could not run ${file}: ${error.message}` }))
          : Effect.succeed(stdout),
      ),
    )
  })

const portOf = (address: string) => Number(address.slice(address.lastIndexOf(":") + 1))

export const parseSs = (text: string): Array<Listener> =>
  text.split("\n").flatMap((line) => {
    const [, , , local = "", , ...users] = line.trim().split(/\s+/)
    const port = portOf(local)
    if (local === "" || !Number.isInteger(port)) return []
    return [...users.join(" ").matchAll(/\("(.*?)",pid=(\d+),fd=\d+\)/g)].map(([, command = "", pid]) => ({
      pid: Number(pid),
      command,
      port,
    }))
  })

const parseLsofFields = (text: string) => {
  const processes: Array<{ pid: number; command: string; names: Array<string> }> = []
  for (const line of text.split("\n")) {
    const value = line.slice(1)
    const current = processes.at(-1)
    if (line.startsWith("p")) processes.push({ pid: Number(value), command: "", names: [] })
    else if (line.startsWith("c") && current) current.command = value
    else if (line.startsWith("n") && current) current.names.push(value)
  }
  return processes
}

const psParentPids = exec("ps", ["-axo", "pid=,ppid="]).pipe(
  Effect.map(
    (text) =>
      new Map(
        text
          .split("\n")
          .map((line) => line.trim().split(/\s+/).map(Number))
          .filter((fields): fields is [number, number] => fields.length === 2 && fields.every(Number.isInteger)),
      ),
  ),
)

const procParentOf = (pid: number) =>
  readFile(`/proc/${pid}/stat`, "utf8").then(
    (stat) => Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]),
    () => undefined,
  )

const procParentPids = (pids: ReadonlyArray<number>) =>
  Effect.promise(async () => {
    const parents = new Map<number, number>()
    await Promise.all(
      pids.map(async (pid) => {
        for (let child = pid; child > 1 && !parents.has(child);) {
          const parent = await procParentOf(child)
          if (parent === undefined || !Number.isInteger(parent)) return
          parents.set(child, parent)
          child = parent
        }
      }),
    )
    return parents
  })

const attribute = (
  listeners: ReadonlyArray<Listener>,
  parentsOf: (pids: ReadonlyArray<number>) => Effect.Effect<ReadonlyMap<number, number>, PortsError>,
  cwds: (pids: ReadonlyArray<number>) => Effect.Effect<ReadonlyMap<number, string | null>, PortsError>,
  include: (process: ProcessInfo) => boolean,
) =>
  Effect.gen(function* () {
    if (listeners.length === 0) return []
    const pids = [...new Set(listeners.map(({ pid }) => pid))]
    const [parents, cwdOf] = yield* Effect.all([parentsOf(pids), cwds(pids)], { concurrency: 2 })
    const ancestorsOf = ancestorsIn(parents)
    return uniqueByPortAndPid(
      listeners.flatMap(({ pid, command, port }) => {
        const proc: ProcessInfo = { pid, command, cwd: cwdOf.get(pid) ?? null, ancestors: ancestorsOf(pid) }
        return include(proc) ? [{ ...proc, port }] : []
      }),
    )
  })

const procCwds = (pids: ReadonlyArray<number>) =>
  Effect.promise(() =>
    Promise.all(
      pids.map((pid) =>
        readlink(`/proc/${pid}/cwd`).then(
          (cwd) => [pid, cwd] as const,
          () => [pid, null] as const,
        ),
      ),
    ),
  ).pipe(Effect.map((entries) => new Map(entries)))

const lsofCwds = (pids: ReadonlyArray<number>) =>
  exec("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"]).pipe(
    Effect.map((text) => new Map(parseLsofFields(text).map(({ pid, names }) => [pid, names[0] ?? null]))),
  )

const TCP_LISTEN = "0A"

export const listeningSockets = (procNetTcp: string) =>
  procNetTcp
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const [, local, , state, , , , , , inode] = line.trim().split(/\s+/)
      return state === TCP_LISTEN ? [`${local}/${inode}`] : []
    })

type ProcTable = { readonly text: string } | { readonly error: NodeJS.ErrnoException }

export const socketsFingerprint = (tables: ReadonlyArray<ProcTable>): string | null =>
  tables.some((table) => "error" in table && table.error.code !== "ENOENT")
    ? null
    : tables
        .flatMap((table) => ("text" in table ? listeningSockets(table.text) : []))
        .toSorted()
        .join(" ")

const procListeningSockets = Effect.promise(() =>
  Promise.all(
    ["/proc/net/tcp", "/proc/net/tcp6"].map((table) =>
      readFile(table, "utf8").then(
        (text): ProcTable => ({ text }),
        (error: NodeJS.ErrnoException): ProcTable => ({ error }),
      ),
    ),
  ),
).pipe(Effect.map(socketsFingerprint))

let ssForSockets: { readonly key: string; readonly listeners: ReadonlyArray<Listener> } | undefined

const scanSs = exec("ss", ["-Hltnp"]).pipe(Effect.map(parseSs))

const ssListeners = (fresh: boolean) =>
  Effect.gen(function* () {
    const key = yield* procListeningSockets
    if (!fresh && key !== null && ssForSockets?.key === key) return ssForSockets.listeners
    const listeners = yield* scanSs
    if (key !== null) ssForSockets = { key, listeners }
    return listeners
  })

const findListeningPortsWithSs: ListeningScanner = (include, fresh) =>
  ssListeners(fresh).pipe(Effect.flatMap((listeners) => attribute(listeners, procParentPids, procCwds, include)))

const findListeningPortsWithLsof: ListeningScanner = (include) =>
  // FIXME: lsof cuts the command name to nine characters unless given +c 0
  exec("lsof", ["-nP", "+c", "0", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]).pipe(
    Effect.map((text) =>
      parseLsofFields(text).flatMap(({ pid, command, names }) =>
        names
          .map(portOf)
          .filter(Number.isInteger)
          .map((port) => ({ pid, command, port })),
      ),
    ),
    Effect.flatMap((listeners) => attribute(listeners, () => psParentPids, lsofCwds, include)),
  )

const LISTENING_REMOTE = /^(0\.0\.0\.0|\[::\]):0$/

export const parseNetstat = (text: string): Array<{ pid: number; port: number }> =>
  text.split("\n").flatMap((line) => {
    const [protocol, local = "", remote = "", , owner] = line.trim().split(/\s+/)
    const port = portOf(local)
    const pid = Number(owner)
    if (protocol !== "TCP" || !LISTENING_REMOTE.test(remote) || !Number.isInteger(port) || !Number.isInteger(pid)) {
      return []
    }
    return [{ pid, port }]
  })

interface WindowsProcess {
  readonly parent: number
  readonly command: string
}

const WINDOWS_PROCESSES =
  "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.Name }"

const windowsProcesses = exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESSES]).pipe(
  Effect.map(
    (text) =>
      new Map(
        text.split("\n").flatMap((line): Array<[number, WindowsProcess]> => {
          const [pid, parent, ...name] = line.trim().split(" ")
          return pid && parent ? [[Number(pid), { parent: Number(parent), command: name.join(" ") }]] : []
        }),
      ),
  ),
)

let processesForListeners: { readonly key: string; readonly table: ReadonlyMap<number, WindowsProcess> } | undefined

const windowsProcessesFor = (listenerPids: ReadonlyArray<number>) => {
  const key = [...new Set(listenerPids)].toSorted((a, b) => a - b).join(",")
  if (processesForListeners?.key === key) return Effect.succeed(processesForListeners.table)
  return windowsProcesses.pipe(Effect.tap((table) => Effect.sync(() => (processesForListeners = { key, table }))))
}

const noCwds = () => Effect.succeed(new Map<number, string | null>())

const findListeningPortsWithNetstat: ListeningScanner = (include) =>
  Effect.gen(function* () {
    const sockets = parseNetstat(yield* exec("netstat", ["-ano"]))
    if (sockets.length === 0) return []
    const table = yield* windowsProcessesFor(sockets.map(({ pid }) => pid))
    const listeners = sockets.map(({ pid, port }) => ({ pid, port, command: table.get(pid)?.command ?? "" }))
    const parents = new Map([...table].map(([pid, { parent }]) => [pid, parent]))
    return yield* attribute(listeners, () => Effect.succeed(parents), noCwds, include)
  })

const isInside = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

export const belongsToWorkspace =
  ({
    workspacePath,
    agentPids,
    selfPid,
  }: {
    readonly workspacePath: string | null
    readonly agentPids: ReadonlySet<number>
    readonly selfPid: number
  }) =>
  (proc: ProcessInfo): boolean => {
    if (proc.pid === selfPid || agentPids.has(proc.pid)) return false
    if (proc.ancestors.some((pid) => agentPids.has(pid))) return true
    if (proc.ancestors.includes(selfPid) || workspacePath === null) return false
    return proc.cwd !== null && isInside(proc.cwd, workspacePath)
  }

type PidOf = () => number | undefined

const agentPidsByThread = new Map<string, Set<PidOf>>()

export const registerAgentPid = (threadId: string, pidOf: PidOf): (() => void) => {
  const pids = agentPidsByThread.get(threadId) ?? new Set()
  pids.add(pidOf)
  agentPidsByThread.set(threadId, pids)
  return () => {
    pids.delete(pidOf)
    if (pids.size === 0) agentPidsByThread.delete(threadId)
  }
}

export const agentPidsOf = (threadId: string) =>
  new Set([...(agentPidsByThread.get(threadId) ?? [])].map((pidOf) => pidOf()).filter((pid) => pid !== undefined))

const scanners: Partial<Record<NodeJS.Platform, ListeningScanner>> = {
  linux: findListeningPortsWithSs,
  darwin: findListeningPortsWithLsof,
  win32: findListeningPortsWithNetstat,
}
const scanListening: ListeningScanner = scanners[process.platform] ?? (() => Effect.succeed([]))

const KILL_GRACE = "3 seconds"

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
      options?: { readonly fresh?: boolean },
    ) => Effect.Effect<ReadonlyArray<OpenPort>, PersistenceError | NotFoundError | FolderMissingError | PortsError>
    readonly kill: (pid: number) => Effect.Effect<void, PortsError>
    readonly closeThread: (threadId: string) => Effect.Effect<void>
  }
>()("hinacode/Ports") {}

const terminate = (pid: number) =>
  Effect.gen(function* () {
    if (!signal(pid, "SIGTERM")) return yield* new PortsError({ message: `Could not stop process ${pid}` })
    yield* Effect.sleep(KILL_GRACE).pipe(
      Effect.andThen(Effect.sync(() => signal(pid, 0) && signal(pid, "SIGKILL"))),
      Effect.forkDetach,
    )
  })

const kill = (pid: number) =>
  Effect.gen(function* () {
    const listening = yield* scanListening((proc) => proc.pid === pid, true)
    if (listening.length === 0) {
      return yield* new PortsError({ message: `Process ${pid} is not listening on a port` })
    }
    yield* terminate(pid)
  })

const make = Effect.gen(function* () {
  const activeWorkspace = yield* makeActiveWorkspace

  const listListening = (threadId: string, workspaceCwd: string | null, fresh: boolean) =>
    Effect.gen(function* () {
      // FIXME: process cwds are resolved paths, and macOS's /tmp is a symlink
      const workspacePath =
        workspaceCwd === null ? null : yield* Effect.promise(() => realpath(workspaceCwd).catch(() => workspaceCwd))
      const listening = yield* scanListening(
        belongsToWorkspace({
          workspacePath,
          agentPids: agentPidsOf(threadId),
          selfPid: process.pid,
        }),
        fresh,
      )
      return listening.map(({ port, pid, command, cwd }): OpenPort => ({ port, pid, command, cwd }))
    })

  const listForThread = (threadId: string, options?: { readonly fresh?: boolean }) =>
    activeWorkspace(threadId).pipe(
      Effect.flatMap((workspace) => listListening(threadId, workspace.cwd, options?.fresh === true)),
    )

  const listOwnedByThread = (threadId: string) =>
    activeWorkspace(threadId).pipe(
      Effect.flatMap((workspace) => listListening(threadId, workspace.worktreeRemoved ? null : workspace.cwd, true)),
    )

  const closeThread = (threadId: string) =>
    listOwnedByThread(threadId).pipe(
      Effect.flatMap((ports) =>
        Effect.forEach(new Set(ports.map((port) => port.pid)), (pid) => terminate(pid).pipe(Effect.ignore), {
          discard: true,
        }),
      ),
      Effect.catch((error) => Effect.logWarning("could not stop the ports of a thread", threadId, error)),
    )

  return Ports.of({ listForThread, kill, closeThread })
})

export const layer = Layer.effect(Ports, make)
