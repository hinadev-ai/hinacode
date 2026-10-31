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

export const readLines = (path: string): AsyncIterable<string> =>
  createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity })

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

export const perHome = <A>(make: (home: string) => A) => {
  const byHome = new Map<string, A>()
  return (home: string): A => {
    const existing = byHome.get(home)
    if (existing !== undefined) return existing
    const made = make(home)
    byHome.set(home, made)
    return made
  }
}

export const toThreadUsage = (
  spent: Iterable<{ readonly model: string; readonly tokens: Tokens }>,
  transcripts: number,
): ThreadUsage => {
  const byModel = new Map<string, Tokens>()
  for (const { model, tokens } of spent) byModel.set(model, addTokens(byModel.get(model) ?? noTokens, tokens))
  const models = [...byModel].map(([model, tokens]) => ({ model, ...tokens })).toSorted((a, b) => total(b) - total(a))
  return { models, transcripts }
}
