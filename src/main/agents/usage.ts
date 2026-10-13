import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { createInterface } from "node:readline"
import type { ModelUsage, ThreadUsage } from "../../shared/agent.ts"

export type Tokens = Omit<ModelUsage, "model">

export const noTokens: Tokens = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }

export const addTokens = (a: Tokens, b: Tokens): Tokens => ({
  inputTokens: a.inputTokens + b.inputTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  outputTokens: a.outputTokens + b.outputTokens,
})

const total = (tokens: Tokens) =>
  tokens.inputTokens + tokens.cacheWriteTokens + tokens.cacheReadTokens + tokens.outputTokens

/** Streams a file's lines, so a rollout of a few hundred MB never sits in memory whole. */
export const readLines = (path: string): AsyncIterable<string> =>
  createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity })

/** Parses each file again only after its size or mtime changed, so a refresh reads just the files that grew. */
export const memoizeByFile = <A>(parse: (path: string) => Promise<A>) => {
  const cache = new Map<string, { readonly size: number; readonly mtimeMs: number; readonly value: A }>()
  return async (path: string): Promise<A> => {
    const { size, mtimeMs } = await stat(path)
    const hit = cache.get(path)
    if (hit?.size === size && hit.mtimeMs === mtimeMs) return hit.value
    const value = await parse(path)
    cache.set(path, { size, mtimeMs, value })
    return value
  }
}

/** Sums tokens per model, the model that spent the most first. */
export const toThreadUsage = (
  spent: Iterable<{ readonly model: string; readonly tokens: Tokens }>,
  transcripts: number,
): ThreadUsage => {
  const byModel = new Map<string, Tokens>()
  for (const { model, tokens } of spent) byModel.set(model, addTokens(byModel.get(model) ?? noTokens, tokens))
  const models = [...byModel].map(([model, tokens]) => ({ model, ...tokens })).toSorted((a, b) => total(b) - total(a))
  return { models, transcripts }
}
