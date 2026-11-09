import { describe, expect, test } from "vitest"
import type { WhiteboardElement } from "../../../../shared/artifact.ts"
import { tombstone } from "./elements.ts"
import { EMPTY_SNAPSHOT, mergeScene } from "./scene.ts"

const skeleton = (id: string, extra: Record<string, unknown> = {}): WhiteboardElement => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  ...extra,
})

const full = (id: string, version: number, extra: Record<string, unknown> = {}): WhiteboardElement => ({
  ...skeleton(id),
  version,
  ...extra,
})

const ids = (elements: ReadonlyArray<{ id: string }>) => elements.map((element) => element.id)

describe("mergeScene", () => {
  test("completes every skeleton on the first load and gives it a version", () => {
    const merged = mergeScene(EMPTY_SNAPSHOT, [skeleton("api"), skeleton("db")])
    expect(ids(merged.elements)).toEqual(["api", "db"])
    expect(merged.elements.every((element) => element.version >= 1)).toBe(true)
  })

  test("does not complete the same skeleton twice after it is saved", () => {
    const first = mergeScene(EMPTY_SNAPSHOT, [skeleton("api")])
    const again = mergeScene(first.snapshot, [skeleton("api")], first.elements)
    expect(ids(again.elements)).toEqual(["api"])
    expect(again.elements[0]?.version).toBe(1)
  })

  test("an agent's replacement outranks the developer's element and drops the old label", () => {
    const first = mergeScene(EMPTY_SNAPSHOT, [skeleton("api", { label: { text: "API" } })])
    const withLabel: WhiteboardElement[] = [
      ...first.elements,
      { id: "api:label", type: "text", version: 1, containerId: "api", text: "API" },
    ]
    const saved = mergeScene(first.snapshot, withLabel, first.elements)
    const replaced = mergeScene(
      saved.snapshot,
      [skeleton("api", { x: 400, label: { text: "API v2" } })],
      saved.elements,
    )
    const api = replaced.elements.find((element) => element.id === "api")
    expect(api).toMatchObject({ x: 400 })
    expect(api?.version).toBeGreaterThan(saved.elements.find((element) => element.id === "api")!.version)
  })

  test("the developer's unsaved move wins over an identical remote version", () => {
    const first = mergeScene(EMPTY_SNAPSHOT, [skeleton("api")])
    const saved = mergeScene(
      first.snapshot,
      first.elements.map((element) => ({ ...element })),
      first.elements,
    )
    const moved = saved.elements.map((element) => ({ ...element, x: 999 }))
    const merged = mergeScene(saved.snapshot, first.elements, moved)
    expect(merged.elements.find((element) => element.id === "api")?.x).toBe(999)
  })

  test("an element the agent removed goes away", () => {
    const first = mergeScene(EMPTY_SNAPSHOT, [skeleton("api"), skeleton("db")])
    const removed = mergeScene(first.snapshot, [first.elements[0]!], first.elements)
    expect(ids(removed.elements)).toEqual(["api"])
  })

  test("a deleted element stays deleted when the agent's older copy arrives", () => {
    const first = mergeScene(EMPTY_SNAPSHOT, [skeleton("api"), skeleton("db")])
    const deleted = tombstone(first.elements, new Set(["db"]))
    const merged = mergeScene(first.snapshot, [first.elements[0]!, first.elements[1]!], deleted)
    expect(merged.elements.find((element) => element.id === "db")).toMatchObject({ isDeleted: true })
  })

  test("folds a bound label child into its container", () => {
    const merged = mergeScene(EMPTY_SNAPSHOT, [
      full("api", 3),
      full("api:label", 3, { type: "text", containerId: "api", text: "API" }),
    ])
    expect(ids(merged.elements)).toEqual(["api"])
    expect(merged.elements[0]?.label).toEqual({ text: "API" })
  })
})
