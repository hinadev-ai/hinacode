import { create } from "zustand"
import type { AgentEvent, ApprovalRequest, QuestionRequest } from "@shared/agent.ts"
import type { TranscriptPush } from "@shared/contract.ts"
import type { Message } from "@shared/domain.ts"
import { foldTranscript } from "@shared/foldEvent.ts"
import { call } from "@/lib/connection"

const STREAM_PUBLICATION_INTERVAL_MS = 100

type ReadyHistory = {
  readonly status: "ready"
  readonly messages: readonly Message[]
  readonly approvals: readonly ApprovalRequest[]
  readonly questions: readonly QuestionRequest[]
}

export type ThreadHistory =
  /** `pending` holds pushes that arrive before the snapshot, which may or may not contain them. */
  | { readonly status: "loading"; readonly pending: readonly TranscriptPush[] }
  | { readonly status: "error"; readonly message: string }
  | ReadyHistory

interface MessagesState {
  readonly byThread: Readonly<Record<string, ThreadHistory>>
  /** Loads a thread's history once; later changes arrive through `receive`. */
  readonly load: (threadId: string) => Promise<void>
  /**
   * Reads every loaded history again after a reconnect, since pushes sent while the socket was down are lost.
   * The last known history stays on screen until its new snapshot replaces it in one step.
   */
  readonly reload: () => void
  /** Forgets every history, when the phone disconnects or unpairs. */
  readonly reset: () => void
  readonly receive: (push: TranscriptPush) => void
}

/**
 * Transcript, pending approvals and questions per thread, mirroring the desktop's `stores/messages.ts`.
 * Threads that were never opened ignore pushes: their first `load` reads a snapshot instead.
 */
export const useMessages = create<MessagesState>()((set, get) => {
  const pendingDeltas = new Map<
    string,
    { pushes: [TranscriptPush, ...TranscriptPush[]]; timer: ReturnType<typeof setTimeout> }
  >()
  const takePending = (threadId: string) => {
    const pending = pendingDeltas.get(threadId)
    if (pending === undefined) return []
    clearTimeout(pending.timer)
    pendingDeltas.delete(threadId)
    return pending.pushes
  }
  /** Pushes received while a ready history's snapshot is being read again, so the snapshot can catch up. */
  const reloading = new Map<string, { pushes: TranscriptPush[] }>()
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
      // A `reset` while the request was in flight wins: the snapshot may predate pushes we never got.
      const settle = (update: (pending: readonly TranscriptPush[]) => ThreadHistory) =>
        setHistory(threadId, (history) => (history?.status === "loading" ? update(history.pending) : history))
      try {
        const { seq, messages, approvals, questions } = await call("threads.transcript", { threadId })
        settle((pending) =>
          pending
            .filter((push) => push.seq > seq)
            .reduce<ReadyHistory>(applyPush, { status: "ready", messages, approvals, questions }),
        )
      } catch (cause) {
        settle(() => ({ status: "error", message: cause instanceof Error ? cause.message : String(cause) }))
      }
    },

    reload: () => {
      for (const [threadId, history] of Object.entries(get().byThread)) {
        // A load still in flight is a read, so the connection sends it again and its snapshot is current.
        if (history.status === "loading") continue
        if (history.status === "error") {
          void get().load(threadId)
          continue
        }
        // A newer reload supersedes one still in flight; the identity check below drops the older answer.
        const reload = { pushes: [] as TranscriptPush[] }
        reloading.set(threadId, reload)
        call("threads.transcript", { threadId }).then(
          ({ seq, messages, approvals, questions }) => {
            if (reloading.get(threadId) !== reload) return
            reloading.delete(threadId)
            // Buffered pushes cover every delta still waiting for publication.
            takePending(threadId)
            setHistory(threadId, (current) =>
              current?.status === "ready"
                ? reload.pushes
                    .filter((push) => push.seq > seq)
                    .reduce<ReadyHistory>(applyPush, { status: "ready", messages, approvals, questions })
                : current,
            )
          },
          () => {
            // Keep the last known history; the next reconnect tries again.
            if (reloading.get(threadId) === reload) reloading.delete(threadId)
          },
        )
      }
    },

    reset: () => {
      for (const threadId of [...pendingDeltas.keys()]) takePending(threadId)
      reloading.clear()
      set({ byThread: {} })
    },

    receive: (push) => {
      const threadId = pushThreadId(push)
      reloading.get(threadId)?.pushes.push(push)
      const type = deltaType(push)
      const pending = pendingDeltas.get(threadId)
      if (get().byThread[threadId]?.status === "ready" && type !== undefined) {
        if (pending !== undefined && deltaType(pending.pushes[0]) === type) {
          pending.pushes.push(push)
          return
        }
        if (pending === undefined) {
          // Start once per group; later deltas never postpone publication.
          pendingDeltas.set(threadId, {
            pushes: [push],
            timer: setTimeout(() => {
              const pushes = takePending(threadId)
              setHistory(threadId, (history) =>
                history?.status === "ready" ? pushes.reduce(applyPush, history) : history,
              )
            }, STREAM_PUBLICATION_INTERVAL_MS),
          })
          return
        }
      }
      const pushes = takePending(threadId)
      setHistory(threadId, (history) => {
        switch (history?.status) {
          case "loading":
            return { ...history, pending: [...history.pending, push] }
          case "ready":
            return applyPush(pushes.reduce(applyPush, history), push)
          default:
            return history
        }
      })
    },
  }
})

export const isTranscriptPush = (event: { readonly type: string }): event is TranscriptPush =>
  event.type === "thread.event" || event.type === "message.created" || event.type === "message.updated"

const pushThreadId = (push: TranscriptPush) => (push.type === "thread.event" ? push.threadId : push.message.threadId)
const deltaType = (push: TranscriptPush) =>
  push.type === "thread.event" && (push.event.type === "text_delta" || push.event.type === "reasoning_delta")
    ? push.event.type
    : undefined

function applyPush(history: ReadyHistory, push: TranscriptPush): ReadyHistory {
  switch (push.type) {
    case "message.created":
      return { ...history, messages: [...history.messages, push.message] }
    case "message.updated": {
      const index = history.messages.findIndex((existing) => existing.id === push.message.id)
      return index === -1 ? history : { ...history, messages: history.messages.map((existing, i) => (i === index ? push.message : existing)) }
    }
    case "thread.event": {
      const approvals = foldApprovals(history.approvals, push.event)
      const questions = foldQuestions(history.questions, push.event)
      const messages = foldTranscript(history.messages, push.event, new Date().toISOString())
      if (approvals === history.approvals && questions === history.questions && messages === history.messages) {
        return history
      }
      return { ...history, approvals, questions, messages }
    }
  }
}

function foldApprovals(approvals: readonly ApprovalRequest[], event: AgentEvent): readonly ApprovalRequest[] {
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

function foldQuestions(questions: readonly QuestionRequest[], event: AgentEvent): readonly QuestionRequest[] {
  switch (event.type) {
    case "question_requested":
      return [...questions, event.request]
    case "question_resolved":
      return questions.filter((request) => request.id !== event.requestId)
    case "turn_completed":
    case "turn_failed":
    case "turn_limited":
      return questions.length === 0 ? questions : []
    default:
      return questions
  }
}
