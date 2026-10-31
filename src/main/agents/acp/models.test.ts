import { describe, expect, test } from "@effect/vitest"
import { modelSelector, toModelInfos } from "./models.ts"

const model = (id: string, label: string) => ({
  id,
  label,
  provider: "opencode" as const,
  efforts: [],
  defaultEffort: null,
  fastMode: false,
  autoMode: false,
})

const configOptions = [
  {
    id: "model",
    category: "model",
    type: "select",
    currentValue: "opencode/big-pickle",
    options: [
      { value: "opencode/beam-free", name: "OpenCode/Beam Free" },
      { group: "more", name: "More", options: [{ value: "opencode/big-pickle", name: "OpenCode/Big Pickle" }] },
    ],
  },
  { id: "mode", category: "mode", type: "select", currentValue: "build", options: [] },
]

describe("toModelInfos", () => {
  test("lists the model config option with the agent's current model first", () => {
    expect(toModelInfos({ configOptions }, "opencode")).toStrictEqual([
      model("opencode/big-pickle", "OpenCode/Big Pickle"),
      model("opencode/beam-free", "OpenCode/Beam Free"),
    ])
  })

  test("falls back to the older models field", () => {
    const models = {
      currentModelId: "sonnet",
      availableModels: [
        { modelId: "gpt", name: "GPT" },
        { modelId: "sonnet", name: "Sonnet" },
      ],
    }
    expect(toModelInfos({ models }, "opencode")).toStrictEqual([model("sonnet", "Sonnet"), model("gpt", "GPT")])
  })

  test("lists nothing when the agent offers no model choice", () => {
    expect(toModelInfos({}, "opencode")).toStrictEqual([])
  })
})

describe("modelSelector", () => {
  test("prefers set_config_option over the older set_model", () => {
    const models = { currentModelId: "sonnet", availableModels: [] }
    expect(modelSelector({ configOptions, models })).toStrictEqual({
      via: "config",
      configId: "model",
      current: "opencode/big-pickle",
    })
    expect(modelSelector({ models })).toStrictEqual({ via: "legacy", current: "sonnet" })
    expect(modelSelector({ configOptions: [configOptions[1]!] })).toBeNull()
  })
})
