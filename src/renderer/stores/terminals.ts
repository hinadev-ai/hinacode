import { create } from "zustand"
import type { TerminalSession } from "../../shared/domain.ts"
import { errorMessage, isFolderMissing } from "../lib/errorMessage.ts"
import { loadSize, saveSize, TERMINAL_HEIGHT_BOUNDS } from "../lib/panelSize.ts"
import { callPromise } from "../lib/rpc.ts"
import { attachTerminalOutput, disposeTerminal, focusTerminal } from "../lib/terminalScreens.ts"

export interface TerminalCommand {
  readonly title: string
  readonly line: string
}

interface ThreadTerminals {
  readonly sessions: ReadonlyArray<TerminalSession>
  readonly activeId: string | null
  readonly open: boolean
}

interface TerminalsState {
  readonly byThreadId: Readonly<Record<string, ThreadTerminals>>
  readonly height: number
  readonly error: string | null
  readonly setHeight: (height: number) => void
  readonly setActive: (threadId: string, id: string) => void
  readonly load: (threadId: string) => Promise<void>
  readonly show: (threadId: string, id: string) => void
  readonly toggle: (threadId: string) => Promise<void>
  readonly openSession: (threadId: string, command?: TerminalCommand) => Promise<void>
  readonly close: (threadId: string, id: string) => Promise<void>
  readonly attach: (id: string) => Promise<void>
  readonly markExited: (id: string, exitCode: number | null) => void
  readonly replaceSession: (session: TerminalSession) => void
}

const HEIGHT_KEY = "hinacode.terminalHeight"

const EMPTY: ThreadTerminals = { sessions: [], activeId: null, open: false }

const INITIAL_SIZE = { cols: 120, rows: 16 }

export const useTerminals = create<TerminalsState>()((set, get) => {
  const update = (threadId: string, patch: (current: ThreadTerminals) => Partial<ThreadTerminals>) =>
    set((state) => {
      const current = state.byThreadId[threadId] ?? EMPTY
      return { byThreadId: { ...state.byThreadId, [threadId]: { ...current, ...patch(current) } } }
    })

  const fail = (threadId: string, error: unknown) => {
    set({ error: isFolderMissing(error) ? null : errorMessage(error) })
    update(threadId, () => ({ open: true }))
  }

  const patchSession = (id: string, patch: (session: TerminalSession) => TerminalSession) =>
    set((state) => ({
      byThreadId: Object.fromEntries(
        Object.entries(state.byThreadId).map(([threadId, terminals]) => [
          threadId,
          {
            ...terminals,
            sessions: terminals.sessions.map((session) => (session.id === id ? patch(session) : session)),
          },
        ]),
      ),
    }))

  const markExited = (id: string, exitCode: number | null) =>
    patchSession(id, (session) => ({ ...session, status: "exited", exitCode, command: null }))

  const replaceSession = (next: TerminalSession) => patchSession(next.id, () => next)

  const attach = async (id: string) => {
    const session = await attachTerminalOutput(id)
    if (session) replaceSession(session)
  }

  const loads = new Map<string, Promise<void>>()

  const fetchSessions = async (threadId: string) => {
    const running = await callPromise("terminal.list", { threadId })
    const listed = new Set(running.map((session) => session.id))
    update(threadId, (current) => {
      const sessions = [...running, ...current.sessions.filter((session) => !listed.has(session.id))]
      return { sessions, activeId: current.activeId ?? sessions.at(-1)?.id ?? null }
    })
    for (const session of running) void attach(session.id)
  }

  const load = (threadId: string) => {
    const loading =
      loads.get(threadId) ??
      fetchSessions(threadId).catch((error: unknown) => {
        loads.delete(threadId)
        throw error
      })
    loads.set(threadId, loading)
    return loading
  }

  const openSession = async (threadId: string, command?: TerminalCommand) => {
    try {
      const session = await callPromise("terminal.open", { threadId, ...INITIAL_SIZE, command })
      set({ error: null })
      update(threadId, (current) => ({ sessions: [...current.sessions, session], activeId: session.id, open: true }))
      void attach(session.id)
    } catch (error) {
      fail(threadId, error)
    }
  }

  return {
    byThreadId: {},
    height: loadSize(HEIGHT_KEY, TERMINAL_HEIGHT_BOUNDS) ?? 280,
    error: null,
    setHeight: (height) => {
      saveSize(HEIGHT_KEY, height)
      set({ height })
    },
    setActive: (threadId, id) => update(threadId, () => ({ activeId: id })),
    load,
    show: (threadId, id) => {
      update(threadId, () => ({ activeId: id, open: true }))
      focusTerminal(id)
    },
    toggle: async (threadId) => {
      if (get().byThreadId[threadId]?.open) return update(threadId, () => ({ open: false }))
      try {
        await load(threadId)
        if ((get().byThreadId[threadId] ?? EMPTY).sessions.length === 0) return await openSession(threadId)
        update(threadId, () => ({ open: true }))
      } catch (error) {
        fail(threadId, error)
      }
    },
    openSession,
    close: async (threadId, id) => {
      update(threadId, (current) => {
        const sessions = current.sessions.filter((session) => session.id !== id)
        const index = current.sessions.findIndex((session) => session.id === id)
        const activeId =
          current.activeId === id ? (sessions[Math.min(index, sessions.length - 1)]?.id ?? null) : current.activeId
        return { sessions, activeId, open: sessions.length > 0 && current.open }
      })
      disposeTerminal(id)
      await callPromise("terminal.close", { id })
    },
    attach,
    markExited,
    replaceSession,
  }
})
