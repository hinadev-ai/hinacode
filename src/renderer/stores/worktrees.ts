import { create } from "zustand"
import type { Worktree } from "../../shared/domain.ts"

interface WorktreesState {
  readonly byId: Readonly<Record<string, Worktree>>
  readonly replaceAll: (worktrees: ReadonlyArray<Worktree>) => void
  readonly upsert: (worktree: Worktree) => void
  readonly appendSetupLog: (id: string, chunk: string) => void
}

export const useWorktrees = create<WorktreesState>()((set) => ({
  byId: {},
  replaceAll: (worktrees) => set({ byId: Object.fromEntries(worktrees.map((worktree) => [worktree.id, worktree])) }),
  upsert: (worktree) => set((state) => ({ byId: { ...state.byId, [worktree.id]: worktree } })),
  appendSetupLog: (id, chunk) =>
    set((state) => {
      const worktree = state.byId[id]
      if (!worktree) return state
      return { byId: { ...state.byId, [id]: { ...worktree, setupLog: worktree.setupLog + chunk } } }
    }),
}))
