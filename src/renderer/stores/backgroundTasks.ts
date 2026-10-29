import { useAtomValue } from "@effect/atom-react"
import { Effect } from "effect"
import { Atom } from "effect/reactivity"
import { create } from "zustand"
import type { BackgroundTask } from "../../shared/agent.ts"
import { call } from "../lib/rpc.ts"

interface BackgroundTasksState {
  readonly byThreadId: Readonly<Record<string, ReadonlyArray<BackgroundTask>>>
  readonly replace: (threadId: string, tasks: ReadonlyArray<BackgroundTask>) => void
}

export const useBackgroundTasks = create<BackgroundTasksState>()((set) => ({
  byThreadId: {},
  replace: (threadId, tasks) => set((state) => ({ byThreadId: { ...state.byThreadId, [threadId]: tasks } })),
}))

const loadBackgroundTasksAtom = Atom.family((threadId: string) =>
  Atom.make(
    call("backgroundTasks.list", { threadId }).pipe(
      Effect.tap((tasks) => Effect.sync(() => useBackgroundTasks.getState().replace(threadId, tasks))),
      Effect.asVoid,
    ),
  ),
)

const NO_TASKS: ReadonlyArray<BackgroundTask> = []

export function useThreadBackgroundTasks(threadId: string) {
  useAtomValue(loadBackgroundTasksAtom(threadId))
  return useBackgroundTasks((state) => state.byThreadId[threadId] ?? NO_TASKS)
}
