import { create } from "zustand"
import type { TerminalSession } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { loadSize, saveSize, TERMINAL_HEIGHT_BOUNDS } from "../lib/panelSize.ts"
import { callPromise } from "../lib/rpc.ts"
import { attachTerminalOutput, disposeTerminal } from "../lib/terminalScreens.ts"

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
  readonly toggle: (threadId: string) => Promise<void>
  readonly openSession: (threadId: string, command?: TerminalCommand) => Promise<void>
  readonly close: (threadId: string, id: string) => Promise<void>
  readonly attach: (id: string) => Promise<void>
  readonly markExited: (id: string, exitCode: number | null) => void
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
    set({ error: errorMessage(error) })
    update(threadId, () => ({ open: true }))
  }

  const markExited = (id: string, exitCode: number | null) =>
    set((state) => ({
      byThreadId: Object.fromEntries(
        Object.entries(state.byThreadId).map(([threadId, terminals]) => [
          threadId,
          {
            ...terminals,
            sessions: terminals.sessions.map((session) =>
              session.id === id ? { ...session, status: "exited" as const, exitCode } : session,
            ),
          },
        ]),
      ),
    }))

  const attach = async (id: string) => {
    const session = await attachTerminalOutput(id)
    if (session?.status === "exited") markExited(id, session.exitCode)
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
    toggle: async (threadId) => {
      const current = get().byThreadId[threadId] ?? EMPTY
      if (current.open) return update(threadId, () => ({ open: false }))
      if (current.sessions.length > 0) return update(threadId, () => ({ open: true }))
      try {
        const running = await callPromise("terminal.list", { threadId })
        if (running.length === 0) return await openSession(threadId)
        update(threadId, () => ({ sessions: running, activeId: running.at(-1)?.id ?? null, open: true }))
        for (const session of running) void attach(session.id)
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
  }
})
