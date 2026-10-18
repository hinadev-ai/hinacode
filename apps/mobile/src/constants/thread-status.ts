import type { ThreadStatus } from "@shared/domain.ts"
import type { IconName } from "@/components/icon"
import type { Tone } from "@/components/ui"
import { copy } from "@/lib/copy"

export const threadStatus: Record<ThreadStatus, { label: string; tone: Tone; icon?: IconName }> = {
  idle: { label: copy("mobile_status_idle"), tone: "neutral" },
  running: { label: copy("mobile_status_running"), tone: "running", icon: "RiLoader4Line" },
  awaiting_approval: { label: copy("mobile_status_awaiting"), tone: "attention", icon: "RiErrorWarningLine" },
  limited: { label: copy("mobile_status_limited"), tone: "attention", icon: "RiErrorWarningLine" },
  archived: { label: copy("mobile_status_archived"), tone: "neutral", icon: "RiArchiveLine" },
}
