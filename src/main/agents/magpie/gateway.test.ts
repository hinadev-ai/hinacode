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

  test("offers fast mode only on a model with magpie's priority tier", () => {
    expect(magpieModelInfo({ id: "codex/gpt-6.1-sol", service_tiers: [{ id: "priority" }] }).fastMode).toBe(true)
    expect(magpieModelInfo({ id: "codex/gpt-6.1-sol", service_tiers: [{ id: "flex" }] }).fastMode).toBe(false)
    expect(magpieModelInfo({ id: "openrouter/x" }).fastMode).toBe(false)
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
  const gateway = { origin: "http://127.0.0.1:1", key: MAGPIE_KEY }
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
    expect(claudeGatewayEnv(gateway, { id: "OpenRouter/X" }, false)).toStrictEqual(routing)
  })

  test("declares the efforts the model takes, keyed by its lowercased id", () => {
    expect(
      claudeGatewayEnv(gateway, { id: "OpenRouter/X", reasoning_levels: ["low", "xhigh", "max"] }, false),
    ).toStrictEqual({ ...routing, CLAUDE_CODE_MODEL_CAPABILITIES: "openrouter/x=effort,xhigh_effort,max_effort" })
  })

  const priority = { id: "OpenRouter/X", service_tiers: [{ id: "priority" }] }

  test("asks for Claude's fast speed in every request body when the thread is fast and the model has a fast tier", () => {
    expect(claudeGatewayEnv(gateway, priority, true)).toStrictEqual({
      ...routing,
      CLAUDE_CODE_EXTRA_BODY: '{"speed":"fast"}',
    })
  })

  test("keeps the fields of an inherited extra body and takes its speed out when the thread is not fast", () => {
    const inherited = '{"speed":"fast","metadata":{"team":"a"}}'
    expect(claudeGatewayEnv(gateway, priority, false, inherited)).toStrictEqual({
      ...routing,
      CLAUDE_CODE_EXTRA_BODY: '{"metadata":{"team":"a"}}',
    })
    expect(claudeGatewayEnv(gateway, priority, true, inherited)).toStrictEqual({
      ...routing,
      CLAUDE_CODE_EXTRA_BODY: '{"metadata":{"team":"a"},"speed":"fast"}',
    })
  })

  test("sends no speed when the thread is not fast or the model has no fast tier", () => {
    expect(claudeGatewayEnv(gateway, priority, false)).toStrictEqual(routing)
    expect(claudeGatewayEnv(gateway, { id: "OpenRouter/X" }, true)).toStrictEqual(routing)
  })
})
