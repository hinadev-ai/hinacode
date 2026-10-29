import { create } from "zustand"
import type { AgentEvent, ApprovalRequest, QuestionRequest, SecretRequest } from "../../shared/agent.ts"
import type { TranscriptPush } from "../../shared/contract.ts"
import type { Message } from "../../shared/domain.ts"
import { foldTranscript } from "../../shared/foldEvent.ts"
import { callPromise } from "../lib/rpc.ts"

const STREAM_PUBLICATION_INTERVAL_MS = 100

type ReadyHistory = {
  readonly status: "ready"
  readonly snapshotSeq: number
  readonly messages: ReadonlyArray<Message>
  readonly approvals: ReadonlyArray<ApprovalRequest>
  readonly questions: ReadonlyArray<QuestionRequest>
  readonly secretRequests: ReadonlyArray<SecretRequest>
}

export type ThreadHistory =
  | { readonly status: "loading"; readonly loadId: symbol; readonly pending: ReadonlyArray<TranscriptPush> }
  | { readonly status: "error"; readonly message: string }
  | ReadyHistory

interface MessagesState {
  readonly byThread: Readonly<Record<string, ThreadHistory>>
  readonly load: (threadId: string) => Promise<void>
  readonly unload: (threadId: string) => void
  readonly receive: (push: TranscriptPush) => void
}

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
      const loadId = Symbol(threadId)
      setHistory(threadId, () => ({ status: "loading", loadId, pending: [] }))
      const settle = (update: (pending: ReadonlyArray<TranscriptPush>) => ThreadHistory) =>
        setHistory(threadId, (history) =>
          history?.status === "loading" && history.loadId === loadId ? update(history.pending) : history,
        )
      try {
        const { seq, ...snapshot } = await callPromise("threads.transcript", { threadId })
        settle((pending) =>
          pending
            .filter((push) => push.seq > seq)
            .reduce<ReadyHistory>(applyPush, { status: "ready", snapshotSeq: seq, ...snapshot }),
        )
      } catch (cause) {
        settle(() => ({ status: "error", message: cause instanceof Error ? cause.message : String(cause) }))
      }
    },

    unload: (threadId) => {
      takePending(threadId)
      set((state) => {
        const { [threadId]: _dropped, ...byThread } = state.byThread
        return { byThread }
      })
    },

    receive: (push) => {
      const threadId = pushThreadId(push)
      const current = get().byThread[threadId]
      if (current?.status === "ready" && push.seq <= current.snapshotSeq) return
      const type = deltaType(push)
      const pending = pendingDeltas.get(threadId)
      if (current?.status === "ready" && type !== undefined) {
        if (pending !== undefined && deltaType(pending.pushes[0]) === type) {
          pending.pushes.push(push)
          return
        }
        if (pending === undefined) {
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
      return index === -1 ? history : { ...history, messages: history.messages.with(index, push.message) }
    }
    case "thread.event": {
      const approvals = foldApprovals(history.approvals, push.event)
      const questions = foldQuestions(history.questions, push.event)
      const secretRequests = foldSecretRequests(history.secretRequests, push.event)
      const messages = foldTranscript(history.messages, push.event, new Date().toISOString())
      if (
        approvals === history.approvals &&
        questions === history.questions &&
        secretRequests === history.secretRequests &&
        messages === history.messages
      ) {
        return history
      }
      return { ...history, approvals, questions, secretRequests, messages }
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

function foldQuestions(questions: ReadonlyArray<QuestionRequest>, event: AgentEvent): ReadonlyArray<QuestionRequest> {
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

function foldSecretRequests(requests: ReadonlyArray<SecretRequest>, event: AgentEvent): ReadonlyArray<SecretRequest> {
  switch (event.type) {
    case "secret_requested":
      return [...requests, event.request]
    case "secret_resolved":
      return requests.filter((request) => request.id !== event.requestId)
    case "turn_completed":
    case "turn_failed":
      return requests.length === 0 ? requests : []
    default:
      return requests
  }
}
