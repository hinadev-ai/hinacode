import { describe, expect, test } from "@effect/vitest"
import { claudeGatewayEnv, MAGPIE_KEY, magpieModelInfo, magpieModelInfos } from "./gateway.ts"

describe("magpieModelInfo", () => {
  test("uses the display name and keeps only the efforts Claude Code can send", () => {
    expect(
      magpieModelInfo({
        id: "opencode-go/kimi-k3",
        display_name: "Kimi K3",
        reasoning_levels: ["none", "high", "max"],
      }),
    ).toStrictEqual({
      id: "opencode-go/kimi-k3",
      label: "Kimi K3",
      provider: "magpie",
      efforts: ["high", "max"],
      defaultEffort: null,
      fastMode: false,
      autoMode: false,
    })
  })

  test("labels a model without a display name by its id and gives it no efforts", () => {
    expect(magpieModelInfo({ id: "group/daily" })).toMatchObject({
      id: "group/daily",
      label: "group/daily",
      efforts: [],
    })
  })
})

describe("magpieModelInfos", () => {
  test("names the magpie provider only on labels that more than one model shares", () => {
    expect(
      magpieModelInfos([
        { id: "anthropic/claude-haiku-5-5", display_name: "Claude Haiku 5.5" },
        { id: "claude/claude-haiku-5-5", display_name: "Claude Haiku 5.5" },
        { id: "group/daily", display_name: "Daily" },
      ]).map((model) => model.label),
    ).toStrictEqual(["Claude Haiku 5.5 · anthropic", "Claude Haiku 5.5 · claude", "Daily"])
  })
})

describe("claudeGatewayEnv", () => {
  const routing = {
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_USE_BEDROCK: "",
    CLAUDE_CODE_USE_VERTEX: "",
    CLAUDE_CODE_USE_FOUNDRY: "",
    CLAUDE_CODE_USE_ANTHROPIC_AWS: "",
    CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "",
    CLAUDE_CODE_USE_MANTLE: "",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
    ANTHROPIC_AUTH_TOKEN: MAGPIE_KEY,
    ANTHROPIC_DEFAULT_OPUS_MODEL: "OpenRouter/X",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "OpenRouter/X",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "OpenRouter/X",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "OpenRouter/X",
    ANTHROPIC_SMALL_FAST_MODEL: "OpenRouter/X",
    CLAUDE_CODE_SUBAGENT_MODEL: "OpenRouter/X",
  }

  test("points Claude Code at the gateway, blanks every way around it and pins every tier to the model", () => {
    expect(claudeGatewayEnv("http://127.0.0.1:1", { id: "OpenRouter/X" })).toStrictEqual(routing)
  })

  test("declares the efforts the model takes, keyed by its lowercased id", () => {
    expect(
      claudeGatewayEnv("http://127.0.0.1:1", { id: "OpenRouter/X", reasoning_levels: ["low", "xhigh", "max"] }),
    ).toStrictEqual({ ...routing, CLAUDE_CODE_MODEL_CAPABILITIES: "openrouter/x=effort,xhigh_effort,max_effort" })
  })
})
