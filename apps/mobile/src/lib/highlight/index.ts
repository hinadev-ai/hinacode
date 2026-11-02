import { useEffect, useMemo, useState } from "react"
import { lex } from "@/lib/lexer"
import { type EngineName, parseOnGpu } from "./engine"

export type { EngineName } from "./engine"

/** The labels `gpu-lexer` gives a span. Every highlighter here produces these. */
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

/** Half-open UTF-16 offsets into the source. Spans cover the source in order. */
export interface SyntaxSpan {
  readonly type: SyntaxClass
  readonly start: number
  readonly end: number
}

export interface Highlight {
  readonly spans: readonly SyntaxSpan[]
  /** The engine that produced `spans`. */
  readonly engine: EngineName
}

const CACHE_SIZE = 200
/** Whole files can reach 300 KB; caching them would hold megabytes of source and spans. */
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

/**
 * Spans for `code`, the contents of the file at `path`, and the engine that made them. It answers at once with the CPU lexer, and on the web swaps in
 * gpu-lexer's spans when they arrive.
 */
export function useHighlight(path: string, code: string): Highlight {
  const cpu = useMemo(() => lookup(path, code), [path, code])
  const [gpu, setGpu] = useState<{ code: string; highlight: Highlight } | null>(null)

  useEffect(() => {
    if (cpu.engine === "gpu-lexer") return
    const pending = parseOnGpu(code)
    if (pending === null) return
    let live = true
    pending.then(
      (spans) => {
        const highlight = remember(path, code, { spans, engine: "gpu-lexer" })
        if (live) setGpu({ code, highlight })
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [path, code, cpu])

  return gpu?.code === code ? gpu.highlight : cpu
}
