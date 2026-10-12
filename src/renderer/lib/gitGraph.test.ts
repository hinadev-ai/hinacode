import { describe, expect, test } from "@effect/vitest"
import type { GitCommit } from "../../shared/domain.ts"
import { chipRefs, laneCount, layoutGraph } from "./gitGraph.ts"

const commit = (hash: string, ...parents: Array<string>): GitCommit => ({
  hash,
  parents,
  subject: hash,
  author: "Kalan",
  authoredAt: "2026-10-12T00:00:00Z",
  refs: [],
})

const shape = (commits: ReadonlyArray<GitCommit>) =>
  layoutGraph(commits).map((row) => ({
    hash: row.commit.hash,
    lane: row.lane,
    edges: row.edges.map(({ fromLane, toLane }) => `${fromLane}>${toLane}`),
  }))

describe("layoutGraph", () => {
  test("keeps a linear history in one lane", () => {
    expect(shape([commit("c3", "c2"), commit("c2", "c1"), commit("c1")])).toStrictEqual([
      { hash: "c3", lane: 0, edges: ["0>0"] },
      { hash: "c2", lane: 0, edges: ["0>0"] },
      { hash: "c1", lane: 0, edges: [] },
    ])
  })

  test("puts a second branch tip in a new lane that joins the base where they forked", () => {
    const rows = layoutGraph([commit("feat", "base"), commit("main", "base"), commit("base")])
    expect(shape(rows.map((row) => row.commit))).toStrictEqual([
      { hash: "feat", lane: 0, edges: ["0>0"] },
      { hash: "main", lane: 1, edges: ["0>0", "1>0"] },
      { hash: "base", lane: 0, edges: [] },
    ])
    expect(laneCount(rows)).toBe(2)
  })

  test("opens a lane for a merge's second parent and closes it where it rejoins", () => {
    expect(
      shape([commit("merge", "main", "feat"), commit("main", "base"), commit("feat", "base"), commit("base")]),
    ).toStrictEqual([
      { hash: "merge", lane: 0, edges: ["0>0", "0>1"] },
      { hash: "main", lane: 0, edges: ["1>1", "0>0"] },
      { hash: "feat", lane: 1, edges: ["0>0", "1>0"] },
      { hash: "base", lane: 0, edges: [] },
    ])
  })

  test("keeps the main line in its lane when a branch to its right forked from the same commit", () => {
    expect(shape([commit("m2", "m1", "f1"), commit("f1", "base"), commit("m1", "base"), commit("base")])).toStrictEqual(
      [
        { hash: "m2", lane: 0, edges: ["0>0", "0>1"] },
        { hash: "f1", lane: 1, edges: ["0>0", "1>1"] },
        { hash: "m1", lane: 0, edges: ["1>0", "0>0"] },
        { hash: "base", lane: 0, edges: [] },
      ],
    )
  })

  test("reuses a freed lane and leads lines past the last loaded commit downward", () => {
    expect(
      shape([commit("a", "x"), commit("b", "a2"), commit("a2", "x"), commit("c", "y"), commit("x", "older")]),
    ).toStrictEqual([
      { hash: "a", lane: 0, edges: ["0>0"] },
      { hash: "b", lane: 1, edges: ["0>0", "1>1"] },
      { hash: "a2", lane: 1, edges: ["0>0", "1>0"] },
      { hash: "c", lane: 1, edges: ["0>0", "1>1"] },
      { hash: "x", lane: 0, edges: ["1>1", "0>0"] },
    ])
  })
})

describe("chipRefs", () => {
  test("drops remote HEAD and remote branches that sit where their local branch does", () => {
    expect(chipRefs(["HEAD", "main", "origin/main", "origin/HEAD", "origin/feat/y", "tag: v1"])).toStrictEqual([
      "HEAD",
      "main",
      "origin/feat/y",
      "tag: v1",
    ])
  })
})
