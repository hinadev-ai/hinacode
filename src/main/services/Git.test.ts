import { describe, expect, test } from "@effect/vitest"
import { parseLog } from "./Git.ts"

const record = (...fields: Array<string>) => fields.map((field) => `${field}\0`).join("")

describe("parseLog", () => {
  test("reads a merge, its decorations, and a root commit", () => {
    const output =
      record(
        "c3",
        "c2 b1",
        "Kalan",
        "2026-10-12T10:00:00+09:00",
        "HEAD -> main, origin/main, tag: v1",
        "Merge branch 'feat/x'",
      ) +
      record("b1", "c1", "Agent", "2026-10-11T09:00:00+09:00", "feat/x", "feat(x): add x") +
      record("c2", "c1", "Kalan", "2026-10-11T08:00:00+09:00", "", "fix: a, b -> c") +
      record("c1", "", "Kalan", "2026-10-10T08:00:00+09:00", "", "init")

    expect(parseLog(output)).toStrictEqual([
      {
        hash: "c3",
        parents: ["c2", "b1"],
        subject: "Merge branch 'feat/x'",
        author: "Kalan",
        authoredAt: "2026-10-12T10:00:00+09:00",
        refs: ["HEAD", "main", "origin/main", "tag: v1"],
      },
      {
        hash: "b1",
        parents: ["c1"],
        subject: "feat(x): add x",
        author: "Agent",
        authoredAt: "2026-10-11T09:00:00+09:00",
        refs: ["feat/x"],
      },
      {
        hash: "c2",
        parents: ["c1"],
        subject: "fix: a, b -> c",
        author: "Kalan",
        authoredAt: "2026-10-11T08:00:00+09:00",
        refs: [],
      },
      {
        hash: "c1",
        parents: [],
        subject: "init",
        author: "Kalan",
        authoredAt: "2026-10-10T08:00:00+09:00",
        refs: [],
      },
    ])
  })

  test("a detached HEAD is its own ref, and an empty repository has no commits", () => {
    expect(parseLog(record("a1", "", "K", "2026-10-10T08:00:00Z", "HEAD", "wip"))[0]?.refs).toStrictEqual(["HEAD"])
    expect(parseLog("")).toStrictEqual([])
  })
})
