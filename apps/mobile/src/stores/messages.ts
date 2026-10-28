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
  readonly hasEarlier: boolean
  readonly loadingEarlier: boolean
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
  /** The threads on screen. The desktop streams only their transcripts, so every other history goes stale. */
  readonly watched: ReadonlySet<string>
  /** Marks a thread on screen until the returned function runs, reading a stale history of it again. */
  readonly watch: (threadId: string) => () => void
  /** Loads the newest page of a thread's history once; later changes arrive through `receive`. */
  readonly load: (threadId: string) => Promise<void>
  /**
   * Prepends the page before the oldest loaded message, when there is one and none is loading. Pushes that arrive
   * meanwhile and are newer than the page are replayed onto it.
   */
  readonly loadEarlier: (threadId: string) => Promise<void>
  /**
   * Reads every history on screen again after a reconnect, since pushes sent while the socket was down are lost.
   * The last known history stays on screen until its newest page replaces it in one step. Earlier pages are
   * dropped too, along with one still loading, as they may have changed meanwhile, and load again on request.
   */
  readonly reload: () => void
  /** Forgets every history, when the phone disconnects or unpairs. */
  readonly reset: () => void
  readonly receive: (push: TranscriptPush) => void
}

/**
 * Transcript, pending approvals and questions per thread, mirroring the desktop's `stores/messages.ts`.
 * Threads that were never opened ignore pushes: their first `load` reads a snapshot instead. A thread left keeps its
 * history to show at once when it is opened again, which then reads its newest page.
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
  const currentLoadToken = new Map<string, object>()
  const pushesDuringReload = new Map<string, { pushes: TranscriptPush[] }>()
  const pushesDuringEarlier = new Map<string, { pushes: TranscriptPush[] }>()
  const screens = new Map<string, number>()
  const setHistory = (threadId: string, update: (history: ThreadHistory | undefined) => ThreadHistory | undefined) =>
    set((state) => {
      const history = state.byThread[threadId]
      const next = update(history)
      return next === undefined || next === history ? state : { byThread: { ...state.byThread, [threadId]: next } }
    })

  /** Reads the newest page of a history again, keeping the last known one on screen until it swaps in. */
  const refresh = (threadId: string, history: ThreadHistory) => {
    if (history.status !== "ready") {
      void get().load(threadId)
      return
    }
    const reload = { pushes: [] as TranscriptPush[] }
    pushesDuringReload.set(threadId, reload)
    readPage(threadId).then(
      ({ seq, messages, hasEarlier = false, approvals, questions }) => {
        if (pushesDuringReload.get(threadId) !== reload) return
        pushesDuringReload.delete(threadId)
        pushesDuringEarlier.delete(threadId)
        takePending(threadId)
        setHistory(threadId, (current) =>
          current?.status === "ready"
            ? reload.pushes
                .filter((push) => push.seq > seq)
                .reduce<ReadyHistory>(applyPush, {
                  ...current,
                  messages,
                  hasEarlier,
                  loadingEarlier: false,
                  approvals,
                  questions,
                })
            : current,
        )
      },
      () => {
        if (pushesDuringReload.get(threadId) === reload) pushesDuringReload.delete(threadId)
      },
    )
  }

  return {
    byThread: {},

    load: async (threadId) => {
      const current = get().byThread[threadId]
      if (current?.status === "ready" || (current?.status === "loading" && currentLoadToken.has(threadId))) return
      setHistory(threadId, () => ({ status: "loading", pending: [] }))
      const load = {}
      currentLoadToken.set(threadId, load)
      const settleIfStillCurrent = (update: (pending: readonly TranscriptPush[]) => ThreadHistory) => {
        if (currentLoadToken.get(threadId) !== load) return
        currentLoadToken.delete(threadId)
        setHistory(threadId, (history) => (history?.status === "loading" ? update(history.pending) : history))
      }
      try {
        const { seq, messages, hasEarlier = false, approvals, questions } = await readPage(threadId)
        settleIfStillCurrent((pending) =>
          pending
            .filter((push) => push.seq > seq)
            .reduce<ReadyHistory>(applyPush, {
              status: "ready",
              messages,
              hasEarlier,
              loadingEarlier: false,
              approvals,
              questions,
            }),
        )
      } catch (cause) {
        settleIfStillCurrent(() => ({ status: "error", message: cause instanceof Error ? cause.message : String(cause) }))
      }
    },

    reload: () => {
      for (const [threadId, history] of Object.entries(get().byThread))
        if (get().watched.has(threadId)) {
          currentLoadToken.delete(threadId)
          refresh(threadId, history)
        }
    },

    watched: new Set(),

    watch: (threadId) => {
      const count = screens.get(threadId) ?? 0
      screens.set(threadId, count + 1)
      if (count === 0) {
        set((state) => ({ watched: new Set([...state.watched, threadId]) }))
        const history = get().byThread[threadId]
        if (history !== undefined) refresh(threadId, history)
      }
      let left = false
      return () => {
        if (left) return
        left = true
        const remaining = (screens.get(threadId) ?? 1) - 1
        if (remaining > 0) return void screens.set(threadId, remaining)
        screens.delete(threadId)
        currentLoadToken.delete(threadId)
        set((state) => ({ watched: new Set([...state.watched].filter((id) => id !== threadId)) }))
      }
    },

    loadEarlier: async (threadId) => {
      const history = get().byThread[threadId]
      if (history?.status !== "ready" || !history.hasEarlier || history.loadingEarlier) return
      const before = history.messages[0]?.id
      if (before === undefined) return
      const request = { pushes: [] as TranscriptPush[] }
      pushesDuringEarlier.set(threadId, request)
      const finishIfCurrent = () => {
        if (pushesDuringEarlier.get(threadId) !== request) return false
        pushesDuringEarlier.delete(threadId)
        return true
      }
      const settle = (update: (history: ReadyHistory) => ReadyHistory) =>
        setHistory(threadId, (current) =>
          current?.status === "ready" ? update({ ...current, loadingEarlier: false }) : current,
        )
      setHistory(threadId, (current) => (current?.status === "ready" ? { ...current, loadingEarlier: true } : current))
      try {
        const page = await call("threads.transcript", { threadId, compact: true, page: { before } })
        if (!finishIfCurrent()) return
        const live = takePending(threadId)
        settle((current) => {
          const latest = live.reduce(applyPush, current)
          if (latest.messages[0]?.id !== before) return latest
          // Folded over the whole transcript so each push finds its message as it did live, but only the page
          // keeps the result: the newer messages already show it, including the ones pushes created.
          const replayed = request.pushes
            .filter((push) => push.seq > page.seq && push.type !== "message.created")
            .reduce(applyPush, { ...latest, messages: [...page.messages, ...latest.messages] })
          return {
            ...latest,
            messages: [...replayed.messages.slice(0, page.messages.length), ...latest.messages],
            hasEarlier: page.hasEarlier ?? false,
          }
        })
      } catch {
        if (finishIfCurrent()) settle((current) => current)
      }
    },

    reset: () => {
      for (const threadId of [...pendingDeltas.keys()]) takePending(threadId)
      currentLoadToken.clear()
      pushesDuringReload.clear()
      pushesDuringEarlier.clear()
      set({ byThread: {} })
    },

    receive: (push) => {
      const threadId = pushThreadId(push)
      pushesDuringReload.get(threadId)?.pushes.push(push)
      pushesDuringEarlier.get(threadId)?.pushes.push(push)
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

const readPage = (threadId: string) => call("threads.transcript", { threadId, compact: true, page: {} })

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
