export type ModelBrand =
  | "claude"
  | "codex"
  | "meta"
  | "deepseek"
  | "kimi"
  | "glm"
  | "qwen"
  | "gemini"
  | "grok"
  | "mistral"

const aliases: ReadonlyArray<readonly [string, ModelBrand]> = [
  ["anthropic", "claude"],
  ["claude", "claude"],
  ["openai", "codex"],
  ["codex", "codex"],
  ["gpt", "codex"],
  ["meta", "meta"],
  ["llama", "meta"],
  ["deepseek", "deepseek"],
  ["moonshotai", "kimi"],
  ["moonshot", "kimi"],
  ["kimi", "kimi"],
  ["zhipuai", "glm"],
  ["zhipu", "glm"],
  ["z-ai", "glm"],
  ["glm", "glm"],
  ["qwen", "qwen"],
  ["alibaba", "qwen"],
  ["tongyi", "qwen"],
  ["google", "gemini"],
  ["gemini", "gemini"],
  ["x-ai", "grok"],
  ["xai", "grok"],
  ["grok", "grok"],
  ["mistralai", "mistral"],
  ["mistral", "mistral"],
]

const startsWithAlias = (segment: string, alias: string) =>
  segment.startsWith(alias) && !/[a-z]/.test(segment[alias.length] ?? "")

export function modelBrand(model: string): ModelBrand | null {
  for (const segment of model.toLowerCase().split("/")) {
    for (const [alias, brand] of aliases) {
      if (startsWithAlias(segment, alias)) return brand
    }
  }
  return null
}
