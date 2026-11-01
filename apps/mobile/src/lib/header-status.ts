import type { ThreadStatus } from "@shared/domain.ts"

/**
 * The status the thread header shows. The desktop reports `running` as soon as one request is answered, even while
 * another still waits, so open approvals and questions on screen keep it at awaiting approval.
 */
export const headerStatus = (status: ThreadStatus, waiting: boolean): ThreadStatus =>
  status === "running" && waiting ? "awaiting_approval" : status
