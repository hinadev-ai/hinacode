import { Atom } from "effect/reactivity"
import { isThreadBusy, type ThreadStatus } from "../../shared/domain.ts"
import { useThreads } from "../stores/threads.ts"

const threadSignal = (changed: (from: ThreadStatus, to: ThreadStatus) => boolean) =>
  Atom.family((threadId: string) =>
    Atom.readable((get) => {
      let count = 0
      get.addFinalizer(
        useThreads.subscribe((state, previous) => {
          const from = previous.byId[threadId]?.status
          const to = state.byId[threadId]?.status
          if (from !== undefined && to !== undefined && changed(from, to)) get.setSelf(++count)
        }),
      )
      return count
    }),
  )

export const threadStatusSignal = threadSignal((from, to) => from !== to)
export const threadSettledSignal = threadSignal((from, to) => isThreadBusy(from) && !isThreadBusy(to))
