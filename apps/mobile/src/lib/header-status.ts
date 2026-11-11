import type { ThreadStatus } from "@shared/domain.ts"

export const headerStatus = (status: ThreadStatus, waiting: boolean): ThreadStatus =>
  status === "running" && waiting ? "awaiting_approval" : status
