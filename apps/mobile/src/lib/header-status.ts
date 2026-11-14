import type { Thread, ThreadStatus } from "@shared/domain.ts"

export type HeaderStatus = ThreadStatus | "interrupted"

export const headerStatus = ({ status, interruptedAt }: Pick<Thread, "status" | "interruptedAt">, waiting: boolean): HeaderStatus => {
  if (status === "running" && waiting) return "awaiting_approval"
  return status === "idle" && interruptedAt !== null ? "interrupted" : status
}
