import { create } from "zustand"
import type { Thread } from "../../shared/domain.ts"

export interface ThreadsState {
  readonly byId: Readonly<Record<string, Thread>>
  readonly replaceAll: (threads: ReadonlyArray<Thread>) => void
  readonly upsert: (thread: Thread) => void
  readonly remove: (id: string) => void
}

export const useThreads = create<ThreadsState>()((set) => ({
  byId: {},
  replaceAll: (threads) => set({ byId: Object.fromEntries(threads.map((thread) => [thread.id, thread])) }),
  upsert: (thread) => set((state) => ({ byId: { ...state.byId, [thread.id]: thread } })),
  remove: (id) =>
    set((state) => {
      const { [id]: _removed, ...rest } = state.byId
      return { byId: rest }
    }),
}))

const inProjects = (state: Pick<ThreadsState, "byId">, projectIds: ReadonlyArray<string>) => {
  const ids = new Set(projectIds)
  return Object.values(state.byId).filter((thread) => ids.has(thread.projectId))
}

const isActive = (thread: Thread) => thread.status !== "archived"
const isPinned = (thread: Thread) => thread.pinnedAt !== null
const newestFirst = (a: Thread, b: Thread) => b.updatedAt.localeCompare(a.updatedAt)
const isSnoozed = (thread: Thread, now: number) => thread.snoozedUntil !== null && Date.parse(thread.snoozedUntil) > now
export const lastActivity = (thread: Thread) =>
  thread.snoozedUntil !== null && thread.snoozedUntil > thread.updatedAt ? thread.snoozedUntil : thread.updatedAt

export const selectProjectThreads =
  (...projectIds: ReadonlyArray<string>) =>
  (state: Pick<ThreadsState, "byId">) =>
    inProjects(state, projectIds)
      .filter(isActive)
      .toSorted((a, b) => a.sortIndex - b.sortIndex)

export const selectUnpinnedProjectThreads =
  (...projectIds: ReadonlyArray<string>) =>
  (state: Pick<ThreadsState, "byId">) =>
    selectProjectThreads(...projectIds)(state).filter((thread) => !isPinned(thread))

export const selectInboxThreads = (now: number) => (state: Pick<ThreadsState, "byId">) =>
  Object.values(state.byId)
    .filter((thread) => isActive(thread) && !isPinned(thread) && !isSnoozed(thread, now))
    .toSorted((a, b) => lastActivity(b).localeCompare(lastActivity(a)))

export const selectAwakeThreads = (now: number) => (state: Pick<ThreadsState, "byId">) =>
  Object.values(state.byId).filter((thread) => isActive(thread) && !isSnoozed(thread, now))

export const selectSnoozedThreads = (now: number) => (state: Pick<ThreadsState, "byId">) =>
  Object.values(state.byId)
    .filter((thread) => isActive(thread) && !isPinned(thread) && isSnoozed(thread, now))
    .toSorted((a, b) => (a.snoozedUntil ?? "").localeCompare(b.snoozedUntil ?? ""))

export const selectPinnedThreads = (state: Pick<ThreadsState, "byId">) =>
  Object.values(state.byId)
    .filter((thread) => isActive(thread) && isPinned(thread))
    .toSorted((a, b) => (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? ""))

export const selectArchivedThreads = (state: Pick<ThreadsState, "byId">) =>
  Object.values(state.byId)
    .filter((thread) => !isActive(thread))
    .toSorted(newestFirst)
