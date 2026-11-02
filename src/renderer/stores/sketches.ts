import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import type { BinaryFiles } from "@excalidraw/excalidraw/types"
import { create } from "zustand"

export interface Sketch {
  readonly elements: ReadonlyArray<OrderedExcalidrawElement>
  readonly files: BinaryFiles
}

interface SketchesState {
  readonly byThreadId: Readonly<Record<string, Sketch>>
  readonly save: (threadId: string, sketch: Sketch) => void
}

export const useSketches = create<SketchesState>()((set) => ({
  byThreadId: {},
  save: (threadId, sketch) => set((state) => ({ byThreadId: { ...state.byThreadId, [threadId]: sketch } })),
}))

export const hasDrawing = (sketch: Sketch | undefined): sketch is Sketch =>
  sketch !== undefined && sketch.elements.some((element) => !element.isDeleted)
