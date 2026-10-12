import { Effect } from "effect"
import { Atom } from "effect/reactivity"
import { create } from "zustand"
import type { PullRequestLink } from "../../shared/domain.ts"
import { call } from "../lib/rpc.ts"

interface PullRequestsState {
  /** Links per thread id. A thread is absent until its links are loaded or pushed. */
  readonly byThreadId: Readonly<Record<string, ReadonlyArray<PullRequestLink>>>
  readonly replace: (threadId: string, links: ReadonlyArray<PullRequestLink>) => void
  /** Stores links for every thread that has some. */
  readonly addAll: (links: ReadonlyArray<PullRequestLink>) => void
}

/** Pull requests agents linked to threads, kept current by `thread.pullRequests` pushes. */
export const usePullRequests = create<PullRequestsState>()((set) => ({
  byThreadId: {},
  replace: (threadId, links) => set((state) => ({ byThreadId: { ...state.byThreadId, [threadId]: links } })),
  addAll: (links) =>
    set((state) => {
      const loaded: Record<string, Array<PullRequestLink>> = {}
      for (const link of links) (loaded[link.threadId] ??= []).push(link)
      return { byThreadId: { ...state.byThreadId, ...loaded } }
    }),
}))

/** Loads every thread's links once for the sidebar; `thread.pullRequests` pushes keep them current after that. */
export const loadAllPullRequestsAtom = Atom.make(
  call("pullRequests.all", undefined).pipe(
    Effect.tap((links) => Effect.sync(() => usePullRequests.getState().addAll(links))),
    Effect.asVoid,
  ),
).pipe(Atom.keepAlive)

/** Loads a thread's links into the store. Subscribe for the loading and error state; read links from the store. */
export const loadPullRequestsAtom = Atom.family((threadId: string) =>
  Atom.make(
    call("pullRequests.list", { threadId }).pipe(
      Effect.tap((links) => Effect.sync(() => usePullRequests.getState().replace(threadId, links))),
      Effect.asVoid,
    ),
  ),
)
