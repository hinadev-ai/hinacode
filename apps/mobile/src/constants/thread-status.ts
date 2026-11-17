import { copy } from "@/lib/copy"
import type { HeaderStatus } from "@/lib/header-status"

export const threadStatusLabel: Record<HeaderStatus, string> = {
  draft: copy("mobile_status_draft"),
  idle: copy("mobile_status_idle"),
  running: copy("mobile_status_running"),
  awaiting_approval: copy("mobile_status_awaiting"),
  limited: copy("mobile_status_limited"),
  interrupted: copy("mobile_status_interrupted"),
  archived: copy("mobile_status_archived"),
}
