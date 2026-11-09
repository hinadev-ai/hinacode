import { expect, test } from "@effect/vitest"
import { modelBrand } from "./modelBrand.ts"

test("finds the vendor in any model id segment", () => {
  const cases: ReadonlyArray<readonly [string, string | null]> = [
    ["anthropic/opus", "claude"],
    ["claude/opus", "claude"],
    ["codex/gpt-6.1-sol", "codex"],
    ["openai/gpt-6.1-sol", "codex"],
    ["openrouter/deepseek-v4", "deepseek"],
    ["console-openrouter/deepseek/deepseek-v4.1-flash-1017", "deepseek"],
    ["moonshot/kimi-k3", "kimi"],
    ["opencode-go/kimi-k3", "kimi"],
    ["openrouter/moonshotai/kimi-k3.1-pro", "kimi"],
    ["z-ai/glm-5.3-flashx", "glm"],
    ["qwen/qwen3.8-27b", "qwen"],
    ["openrouter/google/gemini-4-argon", "gemini"],
    ["x-ai/grok-4", "grok"],
    ["meta-llama/llama-4", "meta"],
    ["mistralai/mistral-large", "mistral"],
    ["openrouter/typesafe/jev-router", null],
    ["group/daily", null],
    ["metacritic/latest", null],
  ]
  for (const [model, brand] of cases) expect(modelBrand(model), model).toBe(brand)
})
