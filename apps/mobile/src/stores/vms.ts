import { create } from "zustand"
import type { ThreadVm } from "@shared/domain.ts"
import { call } from "@/lib/connection"

interface VmsState {
  readonly byThread: Readonly<Record<string, ThreadVm>>
  readonly load: (threadId: string) => Promise<void>
  readonly reload: () => void
  readonly replace: (threadId: string, vm: ThreadVm) => void
  readonly reset: () => void
}

export const useVms = create<VmsState>()((set, get) => {
  const versions = new Map<string, number>()
  const bump = (threadId: string) => {
    const version = (versions.get(threadId) ?? 0) + 1
    versions.set(threadId, version)
    return version
  }

  return {
    byThread: {},
    load: async (threadId) => {
      const version = bump(threadId)
      const vm = await call("vm.get", { threadId })
      if (versions.get(threadId) === version) get().replace(threadId, vm)
    },
    reload: () => {
      for (const threadId of Object.keys(get().byThread)) void get().load(threadId).catch(() => {})
    },
    replace: (threadId, vm) => {
      bump(threadId)
      set((state) => ({ byThread: { ...state.byThread, [threadId]: vm } }))
    },
    reset: () => {
      versions.clear()
      set({ byThread: {} })
    },
  }
})

export const useThreadVm = (threadId: string): ThreadVm | undefined => useVms((state) => state.byThread[threadId])
