import { create } from "zustand"
import { useUi } from "./ui.ts"

interface ArtifactsState {
  readonly selected: Readonly<Record<string, string>>
  readonly select: (threadId: string, id: string | null) => void
}

export const useArtifacts = create<ArtifactsState>()((set) => ({
  selected: {},
  select: (threadId, id) =>
    set((state) => {
      const { [threadId]: _previous, ...others } = state.selected
      return { selected: id === null ? others : { ...others, [threadId]: id } }
    }),
}))

export const openArtifact = (threadId: string, id: string | null) => {
  useArtifacts.getState().select(threadId, id)
  useUi.getState().showView(threadId, "artifacts")
}
