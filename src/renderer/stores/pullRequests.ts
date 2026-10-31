import { Effect } from "effect"
import { Atom } from "effect/reactivity"
import { create } from "zustand"
import type { PullRequestLink } from "../../shared/domain.ts"
import { call } from "../lib/rpc.ts"

interface PullRequestsState {
  readonly byThreadId: Readonly<Record<string, ReadonlyArray<PullRequestLink>>>
  readonly replace: (threadId: string, links: ReadonlyArray<PullRequestLink>) => void
  readonly addAll: (links: ReadonlyArray<PullRequestLink>) => void
}

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

export const loadAllPullRequestsAtom = Atom.make(
  call("pullRequests.all", undefined).pipe(
    Effect.tap((links) => Effect.sync(() => usePullRequests.getState().addAll(links))),
    Effect.asVoid,
  ),
).pipe(Atom.keepAlive)

export const loadPullRequestsAtom = Atom.family((threadId: string) =>
  Atom.make(
    call("pullRequests.list", { threadId }).pipe(
      Effect.tap((links) => Effect.sync(() => usePullRequests.getState().replace(threadId, links))),
      Effect.asVoid,
    ),
  ),
)
