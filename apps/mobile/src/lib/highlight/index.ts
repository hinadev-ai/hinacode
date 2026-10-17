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
const cache = new Map<string, Highlight>()

function remember(code: string, highlight: Highlight) {
  cache.delete(code)
  cache.set(code, highlight)
  const oldest = cache.keys().next().value
  if (cache.size > CACHE_SIZE && oldest !== undefined) cache.delete(oldest)
  return highlight
}

const lookup = (code: string) => remember(code, cache.get(code) ?? { spans: lex(code), engine: "lexer" })

/**
 * Spans for `code` and the engine that made them. It answers at once with the CPU lexer, and on the web swaps in
 * gpu-lexer's spans when they arrive.
 */
export function useHighlight(code: string): Highlight {
  const cpu = useMemo(() => lookup(code), [code])
  const [gpu, setGpu] = useState<{ code: string; highlight: Highlight } | null>(null)

  useEffect(() => {
    if (cpu.engine === "gpu-lexer") return
    const pending = parseOnGpu(code)
    if (pending === null) return
    let live = true
    pending.then(
      (spans) => {
        const highlight = remember(code, { spans, engine: "gpu-lexer" })
        if (live) setGpu({ code, highlight })
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [code, cpu])

  return gpu?.code === code ? gpu.highlight : cpu
}
