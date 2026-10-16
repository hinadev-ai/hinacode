import { describe, expect, test } from "@effect/vitest"
import { MAX_ITEMS_PER_GROUP, rankPalette } from "./rank.ts"
import type { PaletteGroup, PaletteItem } from "./types.ts"

const item = (id: string, group: PaletteGroup, title: string, extra: Partial<PaletteItem> = {}): PaletteItem => ({
  id,
  group,
  title,
  run: () => {},
  ...extra,
})

const ids = (groups: ReturnType<typeof rankPalette>) =>
  groups.map(({ group, items }) => [group, items.map((e) => e.item.id)])

describe("rankPalette", () => {
  const items = [
    item("t1", "threads", "Fix login redirect"),
    item("t2", "threads", "Add palette"),
    item("p1", "projects", "New thread in hinacode"),
    item("f1", "files", "CommandPalette.tsx", { subtitle: "src/renderer/components" }),
  ]

  test("an empty query keeps the given order with recent items first", () => {
    expect(ids(rankPalette(items, "", ["p1", "t2"]))).toStrictEqual([
      ["projects", ["p1"]],
      ["threads", ["t2", "t1"]],
      ["files", ["f1"]],
    ])
  })

  test("drops items the query does not match and orders the rest by score", () => {
    expect(ids(rankPalette(items, "palette", []))).toStrictEqual([
      ["threads", ["t2"]],
      ["files", ["f1"]],
    ])
  })

  test("a recent match outranks a better match that was not run recently", () => {
    expect(ids(rankPalette(items, "palette", ["f1"]))).toStrictEqual([
      ["files", ["f1"]],
      ["threads", ["t2"]],
    ])
  })

  test("reports which title and subtitle characters matched", () => {
    const [files] = rankPalette(items, "palette rend", [])
    expect(files?.items[0]?.titleMatches).toStrictEqual([7, 8, 9, 10, 11, 12, 13])
    expect(files?.items[0]?.subtitleMatches).toStrictEqual([4, 5, 6, 7])
  })

  test("matches keywords without highlighting them", () => {
    const file = item("f2", "files", "index.ts", { subtitle: "src/main", keywords: ["src/main/index.ts"] })
    const [files] = rankPalette([file], "main/ind", [])
    expect(files?.items.map((e) => [e.item.id, e.titleMatches, e.subtitleMatches])).toStrictEqual([["f2", [], []]])
  })

  test("caps each group", () => {
    const many = Array.from({ length: MAX_ITEMS_PER_GROUP + 10 }, (_, i) => item(`f${i}`, "files", `file${i}.ts`))
    expect(rankPalette(many, "file", [])[0]?.items).toHaveLength(MAX_ITEMS_PER_GROUP)
  })
})
