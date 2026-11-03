import { create } from "zustand"
import type { Subagent } from "@shared/agent.ts"
import type { RpcResponse } from "@shared/contract.ts"
import { call } from "@/lib/connection"
import { errorText } from "@/lib/error-text"

export type SubagentWork = RpcResponse<"subagents.transcript">

type WorkState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly work: SubagentWork }
  | { readonly status: "error"; readonly message: string }

interface SubagentsState {
  readonly byThread: Readonly<Record<string, readonly Subagent[]>>
  readonly work: Readonly<Record<string, WorkState>>
  readonly load: (threadId: string) => Promise<void>
  readonly loadWork: (threadId: string, callId: string) => Promise<void>
  readonly reload: () => void
  readonly replace: (threadId: string, subagents: readonly Subagent[]) => void
  readonly reset: () => void
}

const NO_SUBAGENTS: readonly Subagent[] = []

const workKey = (threadId: string, callId: string) => `${threadId}:${callId}`

export const useSubagents = create<SubagentsState>()((set, get) => {
  const versions = new Map<string, number>()
  const bump = (key: string) => {
    const version = (versions.get(key) ?? 0) + 1
    versions.set(key, version)
    return version
  }
  const setWork = (key: string, state: WorkState) => set((current) => ({ work: { ...current.work, [key]: state } }))

  return {
    byThread: {},
    work: {},
    load: async (threadId) => {
      const version = bump(threadId)
      const subagents = await call("subagents.list", { threadId })
      if (versions.get(threadId) === version) get().replace(threadId, subagents)
    },
    loadWork: async (threadId, callId) => {
      const key = workKey(threadId, callId)
      const version = bump(key)
      if (get().work[key] === undefined) setWork(key, { status: "loading" })
      try {
        const work = await call("subagents.transcript", { threadId, callId })
        if (versions.get(key) === version) setWork(key, { status: "ready", work })
      } catch (cause) {
        if (versions.get(key) === version && get().work[key]?.status !== "ready")
          setWork(key, { status: "error", message: errorText(cause) })
      }
    },
    reload: () => {
      for (const threadId of Object.keys(get().byThread)) void get().load(threadId).catch(() => {})
    },
    replace: (threadId, subagents) => {
      bump(threadId)
      set((state) => ({ byThread: { ...state.byThread, [threadId]: subagents } }))
    },
    reset: () => {
      versions.clear()
      set({ byThread: {}, work: {} })
    },
  }
})

export const useThreadSubagents = (threadId: string) =>
  useSubagents((state) => state.byThread[threadId] ?? NO_SUBAGENTS)

export const useSubagentByCallId = (threadId: string, callId: string) =>
  useSubagents((state) => state.byThread[threadId]?.find((subagent) => subagent.callId === callId))

export const useSubagentWork = (threadId: string, callId: string) =>
  useSubagents((state) => state.work[workKey(threadId, callId)])
