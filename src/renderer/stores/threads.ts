import { create } from "zustand"
import type { Thread } from "../../shared/domain.ts"

export interface ThreadsState {
  readonly byId: Readonly<Record<string, Thread>>
  readonly drafts: Readonly<Record<string, Thread>>
  readonly sidechats: Readonly<Record<string, Thread>>
  readonly replaceAll: (threads: ReadonlyArray<Thread>) => void
  readonly upsert: (thread: Thread) => void
  readonly remove: (id: string) => void
}

const byIdOf = (threads: ReadonlyArray<Thread>) => Object.fromEntries(threads.map((thread) => [thread.id, thread]))

const without = (threads: Readonly<Record<string, Thread>>, id: string) => {
  const { [id]: _removed, ...rest } = threads
  return rest
}

export const useThreads = create<ThreadsState>()((set) => ({
  byId: {},
  drafts: {},
  sidechats: {},
  replaceAll: (threads) =>
    set({
      byId: byIdOf(threads.filter((thread) => thread.status !== "draft")),
      drafts: byIdOf(threads.filter((thread) => thread.status === "draft")),
    }),
  upsert: (thread) =>
    set((state) => {
      if (thread.sideOf !== null) return { sidechats: { ...state.sidechats, [thread.sideOf]: thread } }
      return thread.status === "draft"
        ? { byId: without(state.byId, thread.id), drafts: { ...state.drafts, [thread.id]: thread } }
        : { byId: { ...state.byId, [thread.id]: thread }, drafts: without(state.drafts, thread.id) }
    }),
  remove: (id) =>
    set((state) => ({
      byId: without(state.byId, id),
      drafts: without(state.drafts, id),
      sidechats: Object.fromEntries(
        Object.entries(state.sidechats).filter(([parentId, sidechat]) => parentId !== id && sidechat.id !== id),
      ),
    })),
}))

export const selectOpenableThread = (id: string) => (state: Pick<ThreadsState, "byId" | "drafts">) =>
  state.byId[id] ?? state.drafts[id]

export const selectThread = (id: string) => (state: Pick<ThreadsState, "byId" | "drafts" | "sidechats">) =>
  selectOpenableThread(id)(state) ?? Object.values(state.sidechats).find((sidechat) => sidechat.id === id)

const listedThreads = (state: Pick<ThreadsState, "byId">) =>
  Object.values(state.byId).filter((thread) => !thread.conductor)

export const selectConductor = (state: Pick<ThreadsState, "byId">) =>
  Object.values(state.byId).find((thread) => thread.conductor)

const inProjects = (state: Pick<ThreadsState, "byId">, projectIds: ReadonlyArray<string>) => {
  const ids = new Set(projectIds)
  return listedThreads(state).filter((thread) => ids.has(thread.projectId))
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
  listedThreads(state)
    .filter((thread) => isActive(thread) && !isPinned(thread) && !isSnoozed(thread, now))
    .toSorted((a, b) => lastActivity(b).localeCompare(lastActivity(a)))

export const selectAwakeThreads = (now: number) => (state: Pick<ThreadsState, "byId">) =>
  Object.values(state.byId).filter((thread) => isActive(thread) && !isSnoozed(thread, now))

export const selectSnoozedThreads = (now: number) => (state: Pick<ThreadsState, "byId">) =>
  listedThreads(state)
    .filter((thread) => isActive(thread) && !isPinned(thread) && isSnoozed(thread, now))
    .toSorted((a, b) => (a.snoozedUntil ?? "").localeCompare(b.snoozedUntil ?? ""))

export const selectPinnedThreads = (state: Pick<ThreadsState, "byId">) =>
  listedThreads(state)
    .filter((thread) => isActive(thread) && isPinned(thread))
    .toSorted((a, b) => (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? ""))

export const selectArchivedThreads = (state: Pick<ThreadsState, "byId">) =>
  listedThreads(state)
    .filter((thread) => !isActive(thread))
    .toSorted(newestFirst)
