import type { SyntaxSpan } from "@/lib/highlight"

export type EngineName = "gpu-lexer" | "lexer"

let available =
  globalThis.isSecureContext === true &&
  typeof navigator !== "undefined" &&
  (navigator as { gpu?: unknown }).gpu !== undefined

export const canParseOnGpu = () => available

// FIXME: gpu-lexer compiles its pipelines on the first call, so calls run one at a time instead of racing to set up.
let queue: Promise<unknown> = Promise.resolve()

export function parseOnGpu(code: string): Promise<readonly SyntaxSpan[]> | null {
  if (!available) return null
  const result = queue.then(async () => {
    if (!available) throw new Error("gpu-lexer is off")
    const { parse } = await import("gpu-lexer")
    return parse(code)
  })
  queue = result.catch(() => undefined)
  return result.catch((cause: unknown) => {
    available = false
    throw cause
  })
}
