import { describe, expect, test } from "vitest"
import type { ProviderId } from "./agent.ts"
import { accessBehavior } from "./access.ts"

describe("accessBehavior", () => {
  test("Claude's auto mode approves safe actions only on a model that has auto mode", () => {
    expect(accessBehavior("claude", "auto", { autoMode: true })).toBe("autoApprovesSafeActions")
    expect(accessBehavior("claude", "auto", { autoMode: false })).toBe("acceptEdits")
    expect(accessBehavior("claude", "auto", undefined)).toBe("acceptEdits")
  })

  test("magpie's auto mode accepts edits, because its models have no auto mode", () => {
    expect(accessBehavior("magpie", "auto", { autoMode: false })).toBe("acceptEdits")
  })

  test("opencode's auto mode accepts edits", () => {
    expect(accessBehavior("opencode", "auto", undefined)).toBe("acceptEdits")
  })

  test("full access is unrestricted on Muse and bypasses approvals everywhere else", () => {
    expect(accessBehavior("muse", "full", undefined)).toBe("unrestricted")
    for (const provider of ["claude", "magpie", "codex", "opencode"] satisfies ProviderId[]) {
      expect(accessBehavior(provider, "full", { autoMode: true })).toBe("bypass")
    }
  })
})
