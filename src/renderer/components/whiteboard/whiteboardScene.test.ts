import { describe, expect, test } from "vitest"
import type { WhiteboardElement } from "../../../shared/artifact.ts"
import {
  anchorIds,
  EMPTY_SNAPSHOT,
  elementsWithLabels,
  linkBoundArrows,
  mergeRemote,
  planRemote,
  type SceneElement,
  savedSnapshot,
  type Snapshot,
} from "./whiteboardScene.ts"

type Element = SceneElement & { readonly type?: string; readonly text?: string; readonly [key: string]: unknown }

const full = (id: string, version: number, extra: Partial<Element> = {}): Element => ({
  id,
  version,
  type: "rectangle",
  ...extra,
})

const skeleton = (id: string, extra: Record<string, unknown> = {}): WhiteboardElement => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  ...extra,
})

const byVersion = (local: ReadonlyArray<Element>, remote: ReadonlyArray<Element>) => {
  const merged = new Map(local.map((element) => [element.id, element]))
  for (const element of remote) {
    const mine = merged.get(element.id)
    if (mine === undefined || element.version > mine.version) merged.set(element.id, element)
  }
  return [...merged.values()]
}

const merge = (
  snapshot: Snapshot,
  local: ReadonlyArray<Element>,
  remote: ReadonlyArray<WhiteboardElement>,
  complete: (id: string) => ReadonlyArray<Element>,
) => {
  const plan = planRemote(snapshot, remote)
  const completed = remote.flatMap((element) =>
    plan.replaced.has(element.id)
      ? complete(element.id)
      : typeof element["version"] === "number"
        ? [element as Element]
        : [],
  )
  return mergeRemote({ snapshot, plan, local, remote, completed, reconcile: byVersion })
}

const ids = (elements: ReadonlyArray<SceneElement>) => elements.map((element) => element.id)

describe("planRemote", () => {
  test("a first load completes every skeleton and no full element", () => {
    const plan = planRemote(EMPTY_SNAPSHOT, [skeleton("api"), { ...full("mine", 3) }])
    expect([...plan.replaced]).toEqual(["api"])
    expect([...plan.removed]).toEqual([])
  })

  test("only skeletons the agent changed since the last sync are replaced", () => {
    const remote = [skeleton("api"), skeleton("db")]
    const { snapshot } = merge(EMPTY_SNAPSHOT, [], remote, (id) => [full(id, 1)])
    const plan = planRemote(snapshot, [skeleton("api"), skeleton("db", { x: 400 }), skeleton("queue")])
    expect([...plan.replaced]).toEqual(["db", "queue"])
  })

  test("ids that left the remote scene are removed", () => {
    const snapshot = savedSnapshot([full("api", 2), full("db", 2)])
    expect([...planRemote(snapshot, [full("api", 2)]).removed]).toEqual(["db"])
  })
})

describe("mergeRemote", () => {
  test("a skeleton the agent replaced wins over the local element and drops its old label", () => {
    const snapshot = savedSnapshot([full("api", 4), full("api-label", 4, { containerId: "api" })])
    const local = [full("api", 5), full("api-label", 5, { containerId: "api" }), full("mine", 2)]
    const { elements } = merge(
      snapshot,
      local,
      [skeleton("api", { label: { text: "API v2" } }), full("mine", 2)],
      () => [full("api", 1), full("new-label", 1, { containerId: "api", text: "API v2" })],
    )
    expect(ids(elements).toSorted()).toEqual(["api", "mine", "new-label"])
    expect(elements.find((element) => element.id === "api")?.version).toBe(1)
  })

  test("an unchanged skeleton keeps the developer's unsaved edit", () => {
    const first = merge(EMPTY_SNAPSHOT, [], [skeleton("api")], (id) => [full(id, 1)])
    const local = [full("api", 3)]
    const { elements } = merge(first.snapshot, local, [skeleton("api"), skeleton("db")], (id) => [full(id, 1)])
    expect(elements).toEqual([full("api", 3), full("db", 1)])
  })

  test("full elements reconcile by version", () => {
    const snapshot = savedSnapshot([full("a", 2), full("b", 2)])
    const { elements } = merge(snapshot, [full("a", 5), full("b", 2)], [full("a", 3), full("b", 4)], () => [])
    expect(elements).toEqual([full("a", 5), full("b", 4)])
  })

  test("an element the agent removed goes unless the developer edited it since", () => {
    const snapshot = savedSnapshot([full("a", 2), full("b", 2), full("label", 2, { containerId: "a" })])
    const local = [full("a", 2), full("label", 2, { containerId: "a" }), full("b", 3), full("draft", 1)]
    const { elements } = merge(snapshot, local, [], () => [])
    expect(ids(elements)).toEqual(["b", "draft"])
  })

  test("the new snapshot treats the merged skeletons as known", () => {
    const remote = [skeleton("api"), full("mine", 2)]
    const { snapshot } = merge(EMPTY_SNAPSHOT, [], remote, (id) => [full(id, 2), full("label", 1, { containerId: id })])
    expect(planRemote(snapshot, remote).replaced.size).toBe(0)
    expect(snapshot.versions.get("label")).toBe(1)
  })
})

describe("linkBoundArrows", () => {
  test("adds an arrow to the boundElements of the shape it binds to", () => {
    const linked = linkBoundArrows([
      full("api", 2, { boundElements: [{ id: "label", type: "text" }] }),
      full("arrow", 1, { type: "arrow", startBinding: { elementId: "api" }, endBinding: { elementId: "db" } }),
      full("db", 1),
    ])
    expect(linked[0]?.["boundElements"]).toEqual([
      { id: "label", type: "text" },
      { id: "arrow", type: "arrow" },
    ])
    expect(linked[2]?.["boundElements"]).toEqual([{ id: "arrow", type: "arrow" }])
  })

  test("leaves elements that already list the arrow untouched", () => {
    const shape = full("api", 2, { boundElements: [{ id: "arrow", type: "arrow" }] })
    const linked = linkBoundArrows([shape, full("arrow", 1, { type: "arrow", startBinding: { elementId: "api" } })])
    expect(linked[0]).toBe(shape)
  })
})

describe("selection", () => {
  const scene = [
    full("box", 1),
    full("box-label", 1, { type: "text", containerId: "box" }),
    full("note", 1, { type: "text", containerId: null }),
    full("gone", 1, { isDeleted: true }),
  ]

  test("a bound label is asked about through its container", () => {
    expect(anchorIds(["box-label", "box", "note", "gone"], scene)).toEqual(["box", "note"])
  })

  test("the exported elements carry each container's label", () => {
    expect(ids(elementsWithLabels(["box"], scene))).toEqual(["box", "box-label"])
  })
})
