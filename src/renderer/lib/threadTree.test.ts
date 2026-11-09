import { describe, expect, test } from "@effect/vitest"
import type { Thread } from "../../shared/domain.ts"
import { nestChildren } from "./threadTree.ts"

const listed = (id: string, parentId: string | null = null) => ({ id, parentId }) as Thread
const shape = (threads: ReadonlyArray<Thread>) =>
  nestChildren(threads).map(({ thread, nested }) => (nested ? `  ${thread.id}` : thread.id))

describe("nestChildren", () => {
  test("puts children right after their parent, in list order", () => {
    expect(shape([listed("c1", "p"), listed("q"), listed("p"), listed("c2", "p")])).toStrictEqual([
      "q",
      "p",
      "  c1",
      "  c2",
    ])
  })

  test("keeps a child at the top level when its parent is not in the list", () => {
    expect(shape([listed("c", "elsewhere"), listed("q")])).toStrictEqual(["c", "q"])
  })

  test("never nests deeper than one level, and never drops a thread", () => {
    expect(shape([listed("p"), listed("c", "p"), listed("g", "c")])).toStrictEqual(["p", "  c", "g"])
  })
})
