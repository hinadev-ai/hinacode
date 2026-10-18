import { Effect } from "effect"
import { Atom } from "effect/reactivity"
import { create } from "zustand"
import type { Subagent } from "../../shared/agent.ts"
import { call } from "../lib/rpc.ts"

interface SubagentsState {
  /** Sub-agents per thread id, newest first. A thread is absent until loaded or pushed. */
  readonly byThreadId: Readonly<Record<string, ReadonlyArray<Subagent>>>
  readonly replace: (threadId: string, subagents: ReadonlyArray<Subagent>) => void
}

/** Sub-agents spawned by each thread's agent, kept current by `thread.subagents` pushes. */
export const useSubagents = create<SubagentsState>()((set) => ({
  byThreadId: {},
  replace: (threadId, subagents) => set((state) => ({ byThreadId: { ...state.byThreadId, [threadId]: subagents } })),
}))

const NO_SUBAGENTS: ReadonlyArray<Subagent> = []

/** The sub-agent whose tool calls carry `callId`, once the provider has reported it. */
export const useSubagentByCallId = (threadId: string, callId: string) =>
  useSubagents((state) => (state.byThreadId[threadId] ?? NO_SUBAGENTS).find((subagent) => subagent.callId === callId))

/** Loads a thread's sub-agents into the store. Subscribe for the loading and error state; read them from the store. */
export const loadSubagentsAtom = Atom.family((threadId: string) =>
  Atom.make(
    call("subagents.list", { threadId }).pipe(
      Effect.tap((subagents) => Effect.sync(() => useSubagents.getState().replace(threadId, subagents))),
      Effect.asVoid,
    ),
  ),
)
