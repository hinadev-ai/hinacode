import { execFile } from "node:child_process"
import { readlink, realpath } from "node:fs/promises"
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

const parentPids = exec("ps", ["-axo", "pid=,ppid="]).pipe(
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

const attribute = (
  listeners: ReadonlyArray<Listener>,
  parentsOf: Effect.Effect<ReadonlyMap<number, number>, PortsError>,
  cwds: (pids: ReadonlyArray<number>) => Effect.Effect<ReadonlyMap<number, string | null>, PortsError>,
  include: (process: ProcessInfo) => boolean,
) =>
  Effect.gen(function* () {
    if (listeners.length === 0) return []
    const [parents, cwdOf] = yield* Effect.all([parentsOf, cwds([...new Set(listeners.map(({ pid }) => pid))])], {
      concurrency: 2,
    })
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

const findListeningPortsWithSs: ListeningScanner = (include) =>
  exec("ss", ["-Hltnp"]).pipe(Effect.flatMap((text) => attribute(parseSs(text), parentPids, procCwds, include)))

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
    Effect.flatMap((listeners) => attribute(listeners, parentPids, lsofCwds, include)),
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
    return yield* attribute(listeners, Effect.succeed(parents), noCwds, include)
  })

const isInside = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

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

const agentPidsOf = (threadId: string) =>
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
    ) => Effect.Effect<ReadonlyArray<OpenPort>, PersistenceError | NotFoundError | FolderMissingError | PortsError>
    readonly kill: (pid: number) => Effect.Effect<void, PortsError>
  }
>()("hinacode/Ports") {}

const kill = (pid: number) =>
  Effect.gen(function* () {
    const listening = yield* scanListening((proc) => proc.pid === pid)
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
      const workspace = yield* activeWorkspace(threadId)
      // FIXME: process cwds are resolved paths, and macOS's /tmp is a symlink
      const workspacePath = yield* Effect.promise(() => realpath(workspace.cwd).catch(() => workspace.cwd))
      const listening = yield* scanListening(
        belongsToWorkspace({
          workspacePath,
          agentPids: agentPidsOf(threadId),
          selfPid: process.pid,
        }),
      )
      return listening.map(({ port, pid, command, cwd }): OpenPort => ({ port, pid, command, cwd }))
    })

  return Ports.of({ listForThread, kill })
})

export const layer = Layer.effect(Ports, make)
