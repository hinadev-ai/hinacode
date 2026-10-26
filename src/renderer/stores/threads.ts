import { create } from "zustand"
import type { Thread } from "../../shared/domain.ts"

export interface ThreadsState {
  readonly byId: Readonly<Record<string, Thread>>
  readonly replaceAll: (threads: ReadonlyArray<Thread>) => void
  readonly upsert: (thread: Thread) => void
  readonly remove: (id: string) => void
}

/** Threads by id. Loaded once at boot, then kept current by rpc results and `thread.updated` pushes. */
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
/** A thread that woke from a snooze counts as updated when it woke. */
export const lastActivity = (thread: Thread) =>
  thread.snoozedUntil !== null && thread.snoozedUntil > thread.updatedAt ? thread.snoozedUntil : thread.updatedAt

/** The projects' threads that are not archived, in their saved sidebar order. */
export const selectProjectThreads =
  (...projectIds: ReadonlyArray<string>) =>
  (state: Pick<ThreadsState, "byId">) =>
    inProjects(state, projectIds)
      .filter(isActive)
      .toSorted((a, b) => a.sortIndex - b.sortIndex)

/** Like `selectProjectThreads`, without the pinned threads, which the sidebar lists above its tabs. */
export const selectUnpinnedProjectThreads =
  (...projectIds: ReadonlyArray<string>) =>
  (state: Pick<ThreadsState, "byId">) =>
    selectProjectThreads(...projectIds)(state).filter((thread) => !isPinned(thread))

/** Active threads of every project that are neither pinned nor snoozed at `now`, most recent activity first. */
export const selectInboxThreads = (now: number) => (state: Pick<ThreadsState, "byId">) =>
  Object.values(state.byId)
    .filter((thread) => isActive(thread) && !isPinned(thread) && !isSnoozed(thread, now))
    .toSorted((a, b) => lastActivity(b).localeCompare(lastActivity(a)))

/** The Inbox's threads snoozed at `now`, the first to wake on top. */
export const selectSnoozedThreads = (now: number) => (state: Pick<ThreadsState, "byId">) =>
  Object.values(state.byId)
    .filter((thread) => isActive(thread) && !isPinned(thread) && isSnoozed(thread, now))
    .toSorted((a, b) => (a.snoozedUntil ?? "").localeCompare(b.snoozedUntil ?? ""))

/** Active pinned threads of every project, in the order they were pinned. */
export const selectPinnedThreads = (state: Pick<ThreadsState, "byId">) =>
  Object.values(state.byId)
    .filter((thread) => isActive(thread) && isPinned(thread))
    .toSorted((a, b) => (a.pinnedAt ?? "").localeCompare(b.pinnedAt ?? ""))

/** Archived threads of every project, most recently updated first. */
export const selectArchivedThreads = (state: Pick<ThreadsState, "byId">) =>
  Object.values(state.byId)
    .filter((thread) => !isActive(thread))
    .toSorted(newestFirst)
