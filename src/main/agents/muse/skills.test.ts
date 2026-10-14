import { describe, expect, test } from "@effect/vitest"
import { parseSkillInvocation, toCommand } from "./skills.ts"

const selectors = new Set(["probe-echo", "acme:deploy"])

describe("toCommand", () => {
  test("maps a skill/list row to a slash completion", () => {
    expect(toCommand({ selector: "probe-echo", description: "Echo a word.", argumentHint: "[word]" })).toStrictEqual({
      trigger: "/",
      name: "probe-echo",
      description: "Echo a word.",
      argumentHint: "[word]",
    })
    expect(toCommand({ selector: "plan", description: "Plan first." }).argumentHint).toBe("")
  })
})

describe("parseSkillInvocation", () => {
  test("splits the selector from its arguments", () => {
    expect(parseSkillInvocation("/probe-echo banana split", selectors)).toStrictEqual({
      selector: "probe-echo",
      arguments: "banana split",
    })
    expect(parseSkillInvocation("/probe-echo", selectors)).toStrictEqual({ selector: "probe-echo", arguments: "" })
    expect(parseSkillInvocation("  /acme:deploy\nto prod", selectors)).toStrictEqual({
      selector: "acme:deploy",
      arguments: "to prod",
    })
  })

  test("leaves unknown selectors and plain text alone", () => {
    expect(parseSkillInvocation("/unknown-skill do it", selectors)).toBeNull()
    expect(parseSkillInvocation("/tmp/file is broken", selectors)).toBeNull()
    expect(parseSkillInvocation("please run /probe-echo", selectors)).toBeNull()
    expect(parseSkillInvocation("", selectors)).toBeNull()
  })
})
