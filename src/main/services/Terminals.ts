import { randomUUID } from "node:crypto"
import * as pty from "node-pty"
import { Context, Effect, Layer, Schema } from "effect"
import type { PushEvent } from "../../shared/contract.ts"
import type { TerminalAttachment, TerminalSession } from "../../shared/domain.ts"
import { NotFoundError, type PersistenceError } from "./errors.ts"
import { Events } from "./Events.ts"
import { registerAgentPid } from "./Ports.ts"
import { TerminalScrollback } from "./terminalScrollback.ts"
import { makeActiveWorkspace } from "./workspace.ts"

export class TerminalError extends Schema.TaggedError<TerminalError>()("TerminalError", {
  message: Schema.String,
}) {}

const FLUSH_INTERVAL_MS = 16
const FLUSH_SIZE = 256 * 1024
const SCROLLBACK_BYTES = 256 * 1024

interface Live {
  session: TerminalSession
  readonly pty: pty.IPty
  readonly unregisterPid: () => void
  readonly scrollback: TerminalScrollback
  pending: Array<string>
  pendingSize: number
  timer: ReturnType<typeof setTimeout> | undefined
  closing: boolean
}

export class Terminals extends Context.Service<
  Terminals,
  {
    readonly open: (input: {
      readonly threadId: string
      readonly cols: number
      readonly rows: number
    }) => Effect.Effect<TerminalSession, PersistenceError | NotFoundError | TerminalError>
    readonly write: (id: string, data: string) => Effect.Effect<void, NotFoundError>
    readonly resize: (id: string, cols: number, rows: number) => Effect.Effect<void, NotFoundError>
    readonly attach: (id: string, since: number | null) => Effect.Effect<TerminalAttachment, NotFoundError>
    readonly close: (id: string) => Effect.Effect<void>
    readonly list: (threadId: string) => Effect.Effect<ReadonlyArray<TerminalSession>>
    readonly closeThread: (threadId: string) => Effect.Effect<void>
  }
>()("hinacode/Terminals") {}

const make = Effect.gen(function* () {
  const events = yield* Events
  const activeWorkspace = yield* makeActiveWorkspace
  const sessions = new Map<string, Live>()

  const publish = (event: PushEvent) => Effect.runFork(events.publish(event))

  const flush = (live: Live) => {
    clearTimeout(live.timer)
    live.timer = undefined
    if (live.pendingSize === 0) return
    const data = live.pending.join("")
    live.pending = []
    live.pendingSize = 0
    publish({ type: "terminal.data", id: live.session.id, offset: live.scrollback.end - data.length, data })
  }

  const buffer = (live: Live, data: string) => {
    live.scrollback.append(data)
    live.pending.push(data)
    live.pendingSize += data.length
    if (live.pendingSize >= FLUSH_SIZE) flush(live)
    else live.timer ??= setTimeout(() => flush(live), FLUSH_INTERVAL_MS)
  }

  const end = (live: Live) => {
    live.closing = true
    if (live.session.status === "running") live.pty.kill()
    else sessions.delete(live.session.id)
  }

  const find = (id: string) => {
    const live = sessions.get(id)
    return live && !live.closing ? Effect.succeed(live) : Effect.fail(new NotFoundError({ entity: "terminal", id }))
  }

  const open = ({ threadId, cols, rows }: { threadId: string; cols: number; rows: number }) =>
    Effect.gen(function* () {
      const { cwd } = yield* activeWorkspace(threadId)
      const shell = process.env["SHELL"] || "/bin/zsh"
      const proc = yield* Effect.try({
        try: () =>
          pty.spawn(shell, ["-l"], {
            name: "xterm-256color",
            cols,
            rows,
            cwd,
            env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "hinacode" },
          }),
        catch: (cause) => new TerminalError({ message: `Could not start ${shell} in ${cwd}: ${String(cause)}` }),
      })
      const live: Live = {
        session: { id: randomUUID(), threadId, cwd, cols, rows, status: "running", exitCode: null },
        pty: proc,
        unregisterPid: registerAgentPid(threadId, proc.pid),
        scrollback: new TerminalScrollback(SCROLLBACK_BYTES),
        pending: [],
        pendingSize: 0,
        timer: undefined,
        closing: false,
      }
      sessions.set(live.session.id, live)
      proc.onData((data) => buffer(live, data))
      proc.onExit(({ exitCode }) => {
        flush(live)
        live.unregisterPid()
        live.session = { ...live.session, status: "exited", exitCode }
        if (live.closing) sessions.delete(live.session.id)
        publish({ type: "terminal.exited", id: live.session.id, exitCode })
      })
      return live.session
    })

  const write = (id: string, data: string) =>
    Effect.map(find(id), (live) => {
      if (live.session.status === "running") live.pty.write(data)
    })

  const resize = (id: string, cols: number, rows: number) =>
    Effect.map(find(id), (live) => {
      if (live.session.status !== "running") return
      live.pty.resize(cols, rows)
      live.session = { ...live.session, cols, rows }
    })

  const attach = (id: string, since: number | null) =>
    Effect.map(find(id), (live) => ({ session: live.session, ...live.scrollback.from(since ?? 0) }))

  const close = (id: string) =>
    Effect.sync(() => {
      const live = sessions.get(id)
      if (live) end(live)
    })

  const ofThread = (threadId: string) =>
    [...sessions.values()].filter((live) => live.session.threadId === threadId && !live.closing)

  const list = (threadId: string) => Effect.sync(() => ofThread(threadId).map((live) => live.session))

  const closeThread = (threadId: string) => Effect.sync(() => ofThread(threadId).forEach(end))

  yield* Effect.addFinalizer(() => Effect.sync(() => sessions.forEach(end)))

  return Terminals.of({ open, write, resize, attach, close, list, closeThread })
})

export const layer = Layer.effect(Terminals, make)
