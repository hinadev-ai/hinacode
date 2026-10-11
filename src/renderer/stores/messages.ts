import { create } from "zustand"
import type { AgentEvent, ApprovalRequest } from "../../shared/agent.ts"
import type { TranscriptPush } from "../../shared/contract.ts"
import type { Message } from "../../shared/domain.ts"
import { foldTranscript } from "../../shared/foldEvent.ts"
import { callPromise } from "../lib/rpc.ts"

type ReadyHistory = {
  readonly status: "ready"
  readonly messages: ReadonlyArray<Message>
  readonly approvals: ReadonlyArray<ApprovalRequest>
}

export type ThreadHistory =
  /** `pending` holds pushes that arrive before the snapshot, which may or may not contain them. */
  | { readonly status: "loading"; readonly pending: ReadonlyArray<TranscriptPush> }
  | { readonly status: "error"; readonly message: string }
  | ReadyHistory

interface MessagesState {
  readonly byThread: Readonly<Record<string, ThreadHistory>>
  /** Loads a thread's history once; later changes arrive through `receive`. */
  readonly load: (threadId: string) => Promise<void>
  readonly receive: (push: TranscriptPush) => void
}

/**
 * Transcript and pending approvals per thread. Threads that were never opened ignore pushes: their
 * first `load` reads a snapshot instead.
 */
export const useMessages = create<MessagesState>()((set, get) => {
  const setHistory = (threadId: string, update: (history: ThreadHistory | undefined) => ThreadHistory | undefined) =>
    set((state) => {
      const history = state.byThread[threadId]
      const next = update(history)
      return next === undefined || next === history ? state : { byThread: { ...state.byThread, [threadId]: next } }
    })

  return {
    byThread: {},

    load: async (threadId) => {
      const current = get().byThread[threadId]
      if (current !== undefined && current.status !== "error") return
      setHistory(threadId, () => ({ status: "loading", pending: [] }))
      try {
        const { seq, ...snapshot } = await callPromise("threads.transcript", { threadId })
        setHistory(threadId, (history) => {
          const pending = history?.status === "loading" ? history.pending : []
          return pending
            .filter((push) => push.seq > seq)
            .reduce<ReadyHistory>(applyPush, { status: "ready", ...snapshot })
        })
      } catch (cause) {
        setHistory(threadId, () => ({
          status: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        }))
      }
    },

    receive: (push) =>
      setHistory(pushThreadId(push), (history) => {
        switch (history?.status) {
          case "loading":
            return { ...history, pending: [...history.pending, push] }
          case "ready":
            return applyPush(history, push)
          default:
            return history
        }
      }),
  }
})

const pushThreadId = (push: TranscriptPush) => (push.type === "thread.event" ? push.threadId : push.message.threadId)

function applyPush(history: ReadyHistory, push: TranscriptPush): ReadyHistory {
  switch (push.type) {
    case "message.created":
      return { ...history, messages: [...history.messages, push.message] }
    case "message.updated": {
      const index = history.messages.findIndex((existing) => existing.id === push.message.id)
      return index === -1 ? history : { ...history, messages: history.messages.with(index, push.message) }
    }
    case "thread.event": {
      const approvals = foldApprovals(history.approvals, push.event)
      const messages = foldTranscript(history.messages, push.event, new Date().toISOString())
      if (approvals === history.approvals && messages === history.messages) return history
      return { ...history, approvals, messages }
    }
  }
}

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
