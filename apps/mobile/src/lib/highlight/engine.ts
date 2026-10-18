import type { SyntaxSpan } from "@/lib/highlight"

export type EngineName = "gpu-lexer" | "lexer"

/** Native has no WebGPU, so every block keeps the CPU lexer's spans. */
export function parseOnGpu(_code: string): Promise<readonly SyntaxSpan[]> | null {
  return null
}
