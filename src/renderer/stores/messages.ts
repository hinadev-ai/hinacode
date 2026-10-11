import { create } from "zustand"
import type { AgentEvent, ApprovalRequest } from "../../shared/agent.ts"
import type { Message } from "../../shared/domain.ts"
import { foldTranscript } from "../../shared/foldEvent.ts"
import { callPromise } from "../lib/rpc.ts"

export type ThreadHistory =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ready"
      readonly messages: ReadonlyArray<Message>
      readonly approvals: ReadonlyArray<ApprovalRequest>
    }

interface MessagesState {
  readonly byThread: Readonly<Record<string, ThreadHistory>>
  /** Loads a thread's history once; later changes arrive through `addMessage` and `applyEvent`. */
  readonly load: (threadId: string) => Promise<void>
  readonly addMessage: (message: Message) => void
  readonly updateMessage: (message: Message) => void
  readonly applyEvent: (threadId: string, event: AgentEvent) => void
}

/**
 * Transcript and pending approvals per thread. Threads that were never opened are ignored by the
 * push handlers: their first `load` reads the persisted copy instead.
 */
export const useMessages = create<MessagesState>()((set, get) => {
  const updateReady = (
    threadId: string,
    update: (history: Extract<ThreadHistory, { status: "ready" }>) => ThreadHistory,
  ) =>
    set((state) => {
      const history = state.byThread[threadId]
      if (history?.status !== "ready") return state
      const next = update(history)
      return next === history ? state : { byThread: { ...state.byThread, [threadId]: next } }
    })

  return {
    byThread: {},

    load: async (threadId) => {
      const current = get().byThread[threadId]
      if (current !== undefined && current.status !== "error") return
      const setHistory = (history: ThreadHistory) =>
        set((state) => ({ byThread: { ...state.byThread, [threadId]: history } }))
      setHistory({ status: "loading" })
      try {
        const [messages, approvals] = await Promise.all([
          callPromise("messages.list", { threadId }),
          callPromise("approvals.pending", { threadId }),
        ])
        setHistory({ status: "ready", messages, approvals })
      } catch (cause) {
        setHistory({ status: "error", message: cause instanceof Error ? cause.message : String(cause) })
      }
    },

    addMessage: (message) =>
      updateReady(message.threadId, (history) => ({ ...history, messages: [...history.messages, message] })),

    updateMessage: (message) =>
      updateReady(message.threadId, (history) => {
        const index = history.messages.findIndex((existing) => existing.id === message.id)
        return index === -1 ? history : { ...history, messages: history.messages.with(index, message) }
      }),

    applyEvent: (threadId, event) =>
      updateReady(threadId, (history) => {
        const approvals = foldApprovals(history.approvals, event)
        const messages = foldTranscript(history.messages, event, new Date().toISOString())
        if (approvals === history.approvals && messages === history.messages) return history
        return { ...history, approvals, messages }
      }),
  }
})

function foldApprovals(approvals: ReadonlyArray<ApprovalRequest>, event: AgentEvent): ReadonlyArray<ApprovalRequest> {
  switch (event.type) {
    case "approval_requested":
      return [...approvals, event.request]
    case "approval_resolved":
      return approvals.filter((request) => request.id !== event.requestId)
    case "turn_completed":
    case "turn_failed":
      return approvals.length === 0 ? approvals : []
    default:
      return approvals
  }
}
