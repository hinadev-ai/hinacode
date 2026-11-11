import type { SyntaxSpan } from "@/lib/highlight"

export type EngineName = "gpu-lexer" | "lexer"

export const canParseOnGpu = () => false

export function parseOnGpu(_code: string): Promise<readonly SyntaxSpan[]> | null {
  return null
}
