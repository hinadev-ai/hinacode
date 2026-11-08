import type { WhiteboardElement } from "../../../shared/artifact.ts"

export type SceneElement = {
  readonly id: string
  readonly version: number
  readonly isDeleted?: boolean
  readonly containerId?: string | null
}

export type Snapshot = {
  readonly remote: ReadonlyMap<string, string>
  readonly versions: ReadonlyMap<string, number>
}

export const EMPTY_SNAPSHOT: Snapshot = { remote: new Map(), versions: new Map() }

export const isSkeleton = (element: WhiteboardElement) => typeof element["version"] !== "number"

export type RemotePlan = { readonly replaced: ReadonlySet<string>; readonly removed: ReadonlySet<string> }

export const planRemote = (snapshot: Snapshot, remote: ReadonlyArray<WhiteboardElement>): RemotePlan => {
  const present = new Set(remote.map((element) => element.id))
  return {
    replaced: new Set(
      remote
        .filter((element) => isSkeleton(element) && snapshot.remote.get(element.id) !== JSON.stringify(element))
        .map((element) => element.id),
    ),
    removed: new Set([...snapshot.remote.keys()].filter((id) => !present.has(id))),
  }
}

export const mergeRemote = <E extends SceneElement>({
  snapshot,
  plan,
  local,
  remote,
  completed,
  reconcile,
}: {
  readonly snapshot: Snapshot
  readonly plan: RemotePlan
  readonly local: ReadonlyArray<E>
  readonly remote: ReadonlyArray<WhiteboardElement>
  readonly completed: ReadonlyArray<E>
  readonly reconcile: (local: ReadonlyArray<E>, remote: ReadonlyArray<E>) => ReadonlyArray<E>
}) => {
  const editedSince = (element: E) => element.version > (snapshot.versions.get(element.id) ?? 0)
  const localVersions = new Map(local.map((element) => [element.id, element.version]))
  const isReplaced = (element: E) =>
    plan.replaced.has(element.id) || (element.containerId != null && plan.replaced.has(element.containerId))
  const outranking = (element: E): E => {
    if (!isReplaced(element)) return element
    const known = Math.max(localVersions.get(element.id) ?? 0, snapshot.versions.get(element.id) ?? 0)
    return element.version > known ? element : { ...element, version: known + 1 }
  }
  const lifted = completed.map(outranking)
  const dropped = new Set([
    ...plan.replaced,
    ...local.filter((element) => plan.removed.has(element.id) && !editedSince(element)).map((element) => element.id),
  ])
  const kept = local.filter(
    (element) => !dropped.has(element.id) && (element.containerId == null || !dropped.has(element.containerId)),
  )
  const versions = new Map(snapshot.versions)
  for (const id of plan.removed) versions.delete(id)
  for (const element of lifted) versions.set(element.id, element.version)
  return {
    elements: linkBoundArrows(reconcile(kept, lifted)),
    snapshot: {
      remote: new Map(remote.map((element) => [element.id, isSkeleton(element) ? JSON.stringify(element) : ""])),
      versions,
    },
  }
}

export const savedSnapshot = (elements: ReadonlyArray<SceneElement>): Snapshot => ({
  remote: new Map(elements.map((element) => [element.id, ""])),
  versions: new Map(elements.map((element) => [element.id, element.version])),
})

type BoundElement = { readonly id: string; readonly type: string }

export const labelId = (containerId: string) => `${containerId}:label`

export const stableLabelIds = <E extends SceneElement>(elements: ReadonlyArray<E>): E[] => {
  const renamed = new Map(
    elements.flatMap((element) =>
      element.containerId == null || field(element, "type") !== "text"
        ? []
        : [[element.id, labelId(element.containerId)] as const],
    ),
  )
  return elements.map((element) => {
    const id = renamed.get(element.id) ?? element.id
    const bound = field(element, "boundElements") as ReadonlyArray<BoundElement> | null | undefined
    const rebound = bound?.map((entry) => ({ ...entry, id: renamed.get(entry.id) ?? entry.id }))
    return { ...element, id, ...(rebound === undefined || rebound === null ? {} : { boundElements: rebound }) }
  })
}

const field = (element: object, key: string): unknown => (element as Record<string, unknown>)[key]

const boundTarget = (binding: unknown) => {
  const id = typeof binding === "object" && binding !== null ? field(binding, "elementId") : undefined
  return typeof id === "string" ? id : undefined
}

export const linkBoundArrows = <E extends SceneElement>(elements: ReadonlyArray<E>): E[] => {
  const arrowsByTarget = new Map<string, string[]>()
  for (const element of elements) {
    if (element.isDeleted === true || field(element, "type") !== "arrow") continue
    for (const target of new Set([
      boundTarget(field(element, "startBinding")),
      boundTarget(field(element, "endBinding")),
    ])) {
      if (target !== undefined) arrowsByTarget.set(target, [...(arrowsByTarget.get(target) ?? []), element.id])
    }
  }
  return elements.map((element) => {
    const bound = (field(element, "boundElements") as ReadonlyArray<BoundElement> | null | undefined) ?? []
    const missing = (arrowsByTarget.get(element.id) ?? []).filter((id) => !bound.some((entry) => entry.id === id))
    return missing.length === 0
      ? element
      : { ...element, boundElements: [...bound, ...missing.map((id) => ({ id, type: "arrow" }))] }
  })
}

const containerOf = (element: SceneElement, byId: ReadonlyMap<string, SceneElement>) => {
  const container = element.containerId == null ? undefined : byId.get(element.containerId)
  return container === undefined || container.isDeleted === true ? element : container
}

export const anchorIds = (selected: ReadonlyArray<string>, elements: ReadonlyArray<SceneElement>) => {
  const byId = new Map(elements.map((element) => [element.id, element]))
  const ids = selected.flatMap((id) => {
    const element = byId.get(id)
    return element === undefined || element.isDeleted === true ? [] : [containerOf(element, byId).id]
  })
  return [...new Set(ids)]
}

export const elementsWithLabels = <E extends SceneElement>(ids: ReadonlyArray<string>, elements: ReadonlyArray<E>) => {
  const wanted = new Set(ids)
  return elements.filter(
    (element) =>
      element.isDeleted !== true &&
      (wanted.has(element.id) || (element.containerId != null && wanted.has(element.containerId))),
  )
}
