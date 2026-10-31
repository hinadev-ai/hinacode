import { Effect } from "effect"
import { Atom } from "effect/reactivity"
import { create } from "zustand"
import type { Subagent } from "../../shared/agent.ts"
import { call } from "../lib/rpc.ts"

interface SubagentsState {
  readonly byThreadId: Readonly<Record<string, ReadonlyArray<Subagent>>>
  readonly replace: (threadId: string, subagents: ReadonlyArray<Subagent>) => void
}

export const useSubagents = create<SubagentsState>()((set) => ({
  byThreadId: {},
  replace: (threadId, subagents) => set((state) => ({ byThreadId: { ...state.byThreadId, [threadId]: subagents } })),
}))

const NO_SUBAGENTS: ReadonlyArray<Subagent> = []

export const useSubagentByCallId = (threadId: string, callId: string) =>
  useSubagents((state) => (state.byThreadId[threadId] ?? NO_SUBAGENTS).find((subagent) => subagent.callId === callId))

export const loadSubagentsAtom = Atom.family((threadId: string) =>
  Atom.make(
    call("subagents.list", { threadId }).pipe(
      Effect.tap((subagents) => Effect.sync(() => useSubagents.getState().replace(threadId, subagents))),
      Effect.asVoid,
    ),
  ),
)
