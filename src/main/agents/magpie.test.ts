import { describe, expect, test } from "@effect/vitest"
import { CLAUDE_EFFORT_LEVELS } from "../../shared/agent.ts"
import { claudeGatewayEnv, magpieModelInfo } from "./magpie.ts"

describe("magpieModelInfo", () => {
  test("prefixes the id, uses the display name and keeps only the efforts the agent knows", () => {
    expect(
      magpieModelInfo(
        { id: "opencode-go/kimi-k3", display_name: "Kimi K3", reasoning_levels: ["none", "high", "max"] },
        "claude",
        CLAUDE_EFFORT_LEVELS,
      ),
    ).toStrictEqual({
      id: "magpie/opencode-go/kimi-k3",
      label: "Kimi K3",
      provider: "claude",
      efforts: ["high", "max"],
      defaultEffort: null,
      fastMode: false,
      autoMode: false,
    })
  })

  test("labels a model without a display name by its id and gives it no efforts", () => {
    expect(magpieModelInfo({ id: "group/daily" }, "claude", CLAUDE_EFFORT_LEVELS)).toMatchObject({
      id: "magpie/group/daily",
      label: "group/daily",
      efforts: [],
    })
  })
})

describe("claudeGatewayEnv", () => {
  test("points Claude Code at the gateway and every model tier at the chosen model", () => {
    expect(claudeGatewayEnv("http://127.0.0.1:1", "openrouter/x")).toStrictEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
      ANTHROPIC_AUTH_TOKEN: "magpie-hinacode",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "openrouter/x",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "openrouter/x",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "openrouter/x",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "openrouter/x",
      ANTHROPIC_SMALL_FAST_MODEL: "openrouter/x",
      CLAUDE_CODE_SUBAGENT_MODEL: "openrouter/x",
    })
  })
})
