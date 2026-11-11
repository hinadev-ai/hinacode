import { Effect } from "effect"
import { Atom } from "effect/reactivity"
import { create } from "zustand"
import type { PullRequestLink } from "../../shared/domain.ts"
import { call } from "../lib/rpc.ts"

interface PullRequestsState {
  readonly byThreadId: Readonly<Record<string, ReadonlyArray<PullRequestLink>>>
  readonly replace: (threadId: string, links: ReadonlyArray<PullRequestLink>) => void
  readonly startReload: () => (links: ReadonlyArray<PullRequestLink>) => void
}

export const usePullRequests = create<PullRequestsState>()((set) => {
  let pushedDuringReload: Set<string> | null = null
  return {
    byThreadId: {},
    replace: (threadId, links) => {
      pushedDuringReload?.add(threadId)
      set((state) => ({ byThreadId: { ...state.byThreadId, [threadId]: links } }))
    },
    startReload: () => {
      const pushed = new Set<string>()
      pushedDuringReload = pushed
      return (links) => {
        if (pushedDuringReload !== pushed) return
        pushedDuringReload = null
        set((state) => {
          const byThreadId: Record<string, ReadonlyArray<PullRequestLink>> = {}
          for (const link of links) byThreadId[link.threadId] = [...(byThreadId[link.threadId] ?? []), link]
          for (const threadId of pushed) {
            const current = state.byThreadId[threadId]
            if (current !== undefined) byThreadId[threadId] = current
          }
          return { byThreadId }
        })
      }
    },
  }
})

export const loadAllPullRequestsAtom = Atom.make(
  Effect.suspend(() => {
    const finishReload = usePullRequests.getState().startReload()
    return call("pullRequests.all", undefined).pipe(
      Effect.tap((links) => Effect.sync(() => finishReload(links))),
      Effect.asVoid,
    )
  }),
).pipe(Atom.keepAlive)

export const loadPullRequestsAtom = Atom.family((threadId: string) =>
  Atom.make(
    call("pullRequests.list", { threadId }).pipe(
      Effect.tap((links) => Effect.sync(() => usePullRequests.getState().replace(threadId, links))),
      Effect.asVoid,
    ),
  ),
)
