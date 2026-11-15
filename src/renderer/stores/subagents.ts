import { Effect } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { create } from "zustand"
import type { Subagent } from "../../shared/agent.ts"
import type { RpcResponse } from "../../shared/contract.ts"
import { call, familyOf, type RpcError } from "../lib/rpc.ts"

interface SubagentsState {
  readonly byThreadId: Readonly<Record<string, ReadonlyArray<Subagent>>>
  readonly replace: (threadId: string, subagents: ReadonlyArray<Subagent>) => void
}

export const useSubagents = create<SubagentsState>()((set) => ({
  byThreadId: {},
  replace: (threadId, subagents) => set((state) => ({ byThreadId: { ...state.byThreadId, [threadId]: subagents } })),
}))

const NO_SUBAGENTS: ReadonlyArray<Subagent> = []

export const useSubagentByCallId = (threadId: string, callId: string | undefined) =>
  useSubagents((state) => (state.byThreadId[threadId] ?? NO_SUBAGENTS).find((subagent) => subagent.callId === callId))

export const loadSubagentsAtom = Atom.family((threadId: string) =>
  Atom.make(
    call("subagents.list", { threadId }).pipe(
      Effect.tap((subagents) => Effect.sync(() => useSubagents.getState().replace(threadId, subagents))),
      Effect.asVoid,
    ),
  ),
)

export const subagentWorkAtom = familyOf((threadId: string, callId: string, _revision: string) =>
  Atom.make(call("subagents.transcript", { threadId, callId, compact: false })),
)

export const unloadedSubagentWorkAtom = Atom.make(AsyncResult.initial<RpcResponse<"subagents.transcript">, RpcError>())
