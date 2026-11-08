import { convertToExcalidrawElements, reconcileElements, restoreElements } from "@excalidraw/excalidraw"
import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile"
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform"
import type { ExcalidrawElement, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import type { AppState } from "@excalidraw/excalidraw/types"
import type { WhiteboardElement } from "../../../shared/artifact.ts"
import { WHITEBOARD_FONT } from "./systemFonts.ts"
import { isSkeleton, mergeRemote, planRemote, type Snapshot, stableLabelIds } from "./whiteboardScene.ts"

const asBindingTarget = (element: WhiteboardElement, present: ReadonlySet<string>) => {
  if (element["type"] !== "frame" && element["type"] !== "magicframe") return element
  if (!isSkeleton(element)) return { ...element, children: [] }
  const children = element["children"]
  return Array.isArray(children) ? { ...element, children: children.filter((child) => present.has(child)) } : element
}

const withSystemFont = (element: WhiteboardElement) => {
  if (element["type"] === "text") return { ...element, fontFamily: WHITEBOARD_FONT }
  const label = element["label"]
  return typeof label === "object" && label !== null
    ? { ...element, label: { ...label, fontFamily: WHITEBOARD_FONT } }
    : element
}

const completeSkeletons = (remote: ReadonlyArray<WhiteboardElement>, replaced: ReadonlySet<string>) => {
  const present = new Set(remote.map((element) => element.id))
  const converted =
    replaced.size === 0
      ? []
      : stableLabelIds(
          convertToExcalidrawElements(
            remote.map((element) =>
              withSystemFont(asBindingTarget(element, present)),
            ) as unknown as ExcalidrawElementSkeleton[],
            { regenerateIds: false },
          ),
        )
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
