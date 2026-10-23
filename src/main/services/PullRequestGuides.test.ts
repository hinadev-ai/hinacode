import type { Analysis } from "@pulls.review/core/llm"
import type { DiffCategory } from "@pulls.review/core/types"
import { describe, expectTypeOf, test } from "vitest"
import type { GuideCategory, GuideGroup } from "../../shared/domain.ts"

describe("the guide schema", () => {
  test("decodes every answer pulls.review's schema allows", () => {
    expectTypeOf<DiffCategory>().toEqualTypeOf<GuideCategory>()
    expectTypeOf<Analysis>().toExtend<{
      readonly overallSummary: string
      readonly groups: ReadonlyArray<GuideGroup>
    }>()
  })
})
