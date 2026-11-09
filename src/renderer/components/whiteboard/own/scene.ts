import type { WhiteboardElement } from "../../../../shared/artifact.ts"
import {
  EMPTY_SNAPSHOT,
  isSkeleton,
  mergeRemote,
  planRemote,
  savedSnapshot,
  type Snapshot,
} from "../whiteboardScene.ts"
import { completeElement, foldBoundLabels, type OwnElement } from "./elements.ts"

const reconcileByVersion = (mine: ReadonlyArray<OwnElement>, theirs: ReadonlyArray<OwnElement>) => {
  const merged = new Map(mine.map((element) => [element.id, element]))
  for (const element of theirs) {
    const current = merged.get(element.id)
    if (current === undefined || element.version > current.version) merged.set(element.id, element)
  }
  return [...merged.values()]
}

export const mergeScene = (
  snapshot: Snapshot,
  remote: ReadonlyArray<WhiteboardElement>,
  local: ReadonlyArray<OwnElement> = [],
) => {
  const plan = planRemote(snapshot, remote)
  const completed = remote.flatMap((element) =>
    plan.replaced.has(element.id) || !isSkeleton(element) ? [completeElement(element)] : [],
  )
  const merged = mergeRemote<OwnElement>({
    snapshot,
    plan,
    local,
    remote,
    completed,
    reconcile: reconcileByVersion,
  })
  return { elements: foldBoundLabels(merged.elements), snapshot: merged.snapshot }
}

export const sceneSnapshot = (elements: ReadonlyArray<OwnElement>): Snapshot => savedSnapshot(elements)

export { EMPTY_SNAPSHOT, type Snapshot }
