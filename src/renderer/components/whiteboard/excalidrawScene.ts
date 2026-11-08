import { convertToExcalidrawElements, reconcileElements, restoreElements } from "@excalidraw/excalidraw"
import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile"
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform"
import type { ExcalidrawElement, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import type { AppState } from "@excalidraw/excalidraw/types"
import type { WhiteboardElement } from "../../../shared/artifact.ts"
import { isSkeleton, mergeRemote, planRemote, type Snapshot } from "./whiteboardScene.ts"

const asBindingTarget = (element: WhiteboardElement) =>
  !isSkeleton(element) && (element["type"] === "frame" || element["type"] === "magicframe")
    ? { ...element, children: [] }
    : element

const completeSkeletons = (remote: ReadonlyArray<WhiteboardElement>, replaced: ReadonlySet<string>) => {
  const converted =
    replaced.size === 0
      ? []
      : convertToExcalidrawElements(remote.map(asBindingTarget) as unknown as ExcalidrawElementSkeleton[], {
          regenerateIds: false,
        })
  const ordered = remote.flatMap((element): ReadonlyArray<unknown> => {
    if (replaced.has(element.id)) {
      return [
        ...converted.filter((done) => done.id === element.id),
        ...converted.filter((done) => done.type === "text" && done.containerId === element.id),
      ]
    }
    return isSkeleton(element) ? [] : [element]
  })
  return restoreElements(ordered as ExcalidrawElement[], null, { repairBindings: true })
}

export type CanvasState = {
  readonly elements: ReadonlyArray<OrderedExcalidrawElement>
  readonly appState: AppState
}

export const mergeScene = (snapshot: Snapshot, remote: ReadonlyArray<WhiteboardElement>, canvas?: CanvasState) => {
  const plan = planRemote(snapshot, remote)
  return mergeRemote({
    snapshot,
    plan,
    local: canvas?.elements ?? [],
    remote,
    completed: completeSkeletons(remote, plan.replaced),
    reconcile: (mine, theirs) =>
      canvas === undefined
        ? theirs
        : reconcileElements(mine, theirs as ReadonlyArray<RemoteExcalidrawElement>, canvas.appState),
  })
}
