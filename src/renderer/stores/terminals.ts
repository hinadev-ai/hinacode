import { create } from "zustand"
import type { TerminalSession } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { attachTerminalOutput, disposeTerminal } from "../lib/terminalScreens.ts"

interface ThreadTerminals {
  readonly sessions: ReadonlyArray<TerminalSession>
  readonly activeId: string | null
  readonly open: boolean
}

interface TerminalsState {
  readonly byThreadId: Readonly<Record<string, ThreadTerminals>>
  /** Drawer height in px, shared by every thread like the side panel's state. */
  readonly height: number
  readonly error: string | null
  readonly setHeight: (height: number) => void
  readonly setActive: (threadId: string, id: string) => void
  /** Opens or hides the drawer. Opening an empty drawer starts a shell. */
  readonly toggle: (threadId: string) => Promise<void>
  /** Starts another shell and shows it. */
  readonly openSession: (threadId: string) => Promise<void>
  readonly close: (threadId: string, id: string) => Promise<void>
  /** Catches the session's screen up with the output main keeps, as after a reload or a cloud reconnect. */
  readonly attach: (id: string) => Promise<void>
  readonly markExited: (id: string, exitCode: number | null) => void
}

const EMPTY: ThreadTerminals = { sessions: [], activeId: null, open: false }

/** A size close to what the drawer fits; the screen corrects it with `terminal.resize` once it is measured. */
const INITIAL_SIZE = { cols: 120, rows: 16 }

/** Integrated terminal sessions per thread. Output does not pass through here; see `terminalScreens.ts`. */
export const useTerminals = create<TerminalsState>()((set, get) => {
  const update = (threadId: string, patch: (current: ThreadTerminals) => Partial<ThreadTerminals>) =>
    set((state) => {
      const current = state.byThreadId[threadId] ?? EMPTY
      return { byThreadId: { ...state.byThreadId, [threadId]: { ...current, ...patch(current) } } }
    })

  /** Opens the drawer anyway, so the error shows where the shell would have been. */
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

  const openSession = async (threadId: string) => {
    try {
      const session = await callPromise("terminal.open", { threadId, ...INITIAL_SIZE })
      set({ error: null })
      update(threadId, (current) => ({ sessions: [...current.sessions, session], activeId: session.id, open: true }))
      void attach(session.id)
    } catch (error) {
      fail(threadId, error)
    }
  }

  return {
    byThreadId: {},
    height: 280,
    error: null,
    setHeight: (height) => set({ height }),
    setActive: (threadId, id) => update(threadId, () => ({ activeId: id })),
    toggle: async (threadId) => {
      const current = get().byThreadId[threadId] ?? EMPTY
      if (current.open) return update(threadId, () => ({ open: false }))
      if (current.sessions.length > 0) return update(threadId, () => ({ open: true }))
      try {
        // Sessions outlive a renderer reload, so pick up the ones main still runs before starting another.
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
