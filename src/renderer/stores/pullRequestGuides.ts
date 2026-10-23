import { Effect } from "effect"
import { Atom } from "effect/reactivity"
import { create } from "zustand"
import type { PullRequestGuideState } from "../../shared/domain.ts"
import { call, type EnvironmentId, familyOf } from "../lib/rpc.ts"

interface PullRequestGuidesState {
  readonly byUrl: Readonly<Record<string, PullRequestGuideState>>
  readonly replace: (url: string, state: PullRequestGuideState) => void
}

export const usePullRequestGuides = create<PullRequestGuidesState>()((set) => ({
  byUrl: {},
  replace: (url, state) => set((current) => ({ byUrl: { ...current.byUrl, [url]: state } })),
}))

/** Loads a guide's state into the store. Subscribe for the loading and error state; read the guide from the store. */
export const loadPullRequestGuideAtom = familyOf((environment: EnvironmentId, url: string) =>
  Atom.make(
    call("pullRequestGuides.get", { url }, { environment }).pipe(
      Effect.tap((state) => Effect.sync(() => usePullRequestGuides.getState().replace(url, state))),
      Effect.asVoid,
    ),
  ),
)
