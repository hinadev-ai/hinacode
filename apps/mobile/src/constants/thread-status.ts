import type { ThreadStatus } from "@shared/domain.ts"
import { copy } from "@/lib/copy"

/** The thread header's status label. */
export const threadStatusLabel: Record<ThreadStatus, string> = {
  draft: copy("mobile_status_draft"),
  idle: copy("mobile_status_idle"),
  running: copy("mobile_status_running"),
  awaiting_approval: copy("mobile_status_awaiting"),
  limited: copy("mobile_status_limited"),
  archived: copy("mobile_status_archived"),
}
