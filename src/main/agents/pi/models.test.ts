import { describe, expect, it } from "vitest"
import { modelArgs, toModelInfo } from "./models.ts"

describe("toModelInfo", () => {
  it("offers pi's thinking levels, with xhigh and max only when the model maps them", () => {
    expect(
      toModelInfo({
        id: "claude-opus-5.5",
        name: "Claude Opus 5.5",
        provider: "github-copilot",
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null, low: "low", xhigh: "xhigh", max: "max" },
      }),
    ).toStrictEqual({
      id: "github-copilot/claude-opus-5.5",
      label: "github-copilot/Claude Opus 5.5",
      provider: "pi",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      fastMode: false,
      autoMode: false,
    })
    expect(
      toModelInfo({ id: "gpt", provider: "openai", reasoning: true, thinkingLevelMap: { max: null } }).efforts,
    ).toStrictEqual(["off", "minimal", "low", "medium", "high"])
  })

  it("offers no effort for a model without reasoning", () => {
    expect(toModelInfo({ id: "qwen/qwen3-coder", provider: "openrouter", reasoning: false })).toMatchObject({
      id: "openrouter/qwen/qwen3-coder",
      label: "openrouter/qwen/qwen3-coder",
      efforts: [],
      defaultEffort: null,
    })
  })

  it("has no default effort when the model maps medium to null", () => {
    expect(
      toModelInfo({ id: "m", provider: "p", reasoning: true, thinkingLevelMap: { medium: null } }).defaultEffort,
    ).toBeNull()
  })
})

describe("modelArgs", () => {
  it("splits on the first slash, so pi never reads a colon in the id as a thinking level", () => {
    expect(modelArgs("openrouter/anthropic/claude-haiku-4.5:batch")).toStrictEqual([
      "--provider",
      "openrouter",
      "--model",
      "anthropic/claude-haiku-4.5:batch",
    ])
    expect(modelArgs("sonnet")).toStrictEqual(["--model", "sonnet"])
    expect(modelArgs("")).toStrictEqual([])
  })
})
