import type { ThreadStatus } from "@shared/domain.ts"
import type { Tone } from "@/components/ui"
import { copy } from "@/lib/copy"

/** The thread header's status, as on the desktop: a quiet label, colored only when a usage limit stops the thread. */
export const threadStatus: Record<ThreadStatus, { label: string; tone: Tone }> = {
  idle: { label: copy("mobile_status_idle"), tone: "neutral" },
  running: { label: copy("mobile_status_running"), tone: "neutral" },
  awaiting_approval: { label: copy("mobile_status_awaiting"), tone: "neutral" },
  limited: { label: copy("mobile_status_limited"), tone: "attention" },
  archived: { label: copy("mobile_status_archived"), tone: "neutral" },
}
