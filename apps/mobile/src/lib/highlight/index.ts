import { useAtomValue } from "@effect/atom-react"
import { Effect } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { lex } from "@/lib/lexer"
import { familyOf } from "@/lib/remote"
import { canParseOnGpu, type EngineName, parseOnGpu } from "./engine"

export type { EngineName } from "./engine"

export type SyntaxClass =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "type"
  | "function"
  | "constant"
  | "operator"

export interface SyntaxSpan {
  readonly type: SyntaxClass
  readonly start: number
  readonly end: number
}

export interface Highlight {
  readonly spans: readonly SyntaxSpan[]
  readonly engine: EngineName
}

const CACHE_SIZE = 200
const MAX_CACHED_LENGTH = 20_000
const cache = new Map<string, Highlight>()

function remember(path: string, code: string, highlight: Highlight) {
  if (code.length > MAX_CACHED_LENGTH) return highlight
  const key = `${path}\0${code}`
  cache.delete(key)
  cache.set(key, highlight)
  const oldest = cache.keys().next().value
  if (cache.size > CACHE_SIZE && oldest !== undefined) cache.delete(oldest)
  return highlight
}

const lookup = (path: string, code: string) =>
  remember(path, code, cache.get(`${path}\0${code}`) ?? { spans: lex(code, path), engine: "lexer" })

const gpuHighlight = familyOf((path: string, code: string) =>
  Atom.make(() => {
    const cached = cache.get(`${path}\0${code}`)
    if (cached?.engine === "gpu-lexer") return Effect.succeed<Highlight | null>(cached)
    const pending = parseOnGpu(code)
    if (pending === null) return Effect.succeed(null)
    return Effect.tryPromise(() => pending).pipe(
      Effect.map((spans): Highlight | null => remember(path, code, { spans, engine: "gpu-lexer" })),
    )
  }),
)

const withoutGpu = Atom.make(Effect.succeed<Highlight | null>(null))

export function useHighlight(path: string, code: string): Highlight {
  const cpu = lookup(path, code)
  const gpuAtom = canParseOnGpu() ? gpuHighlight(path, code) : withoutGpu
  const gpu = AsyncResult.getOrElse(useAtomValue(gpuAtom), () => null)
  return gpu ?? cpu
}
