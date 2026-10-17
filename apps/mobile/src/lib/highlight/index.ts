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

/** Spans for `code`, or null until they are ready. */
export function useSyntaxSpans(_code: string): readonly SyntaxSpan[] | null {
  return null
}
