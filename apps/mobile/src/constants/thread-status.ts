import type { ThreadStatus } from "@shared/domain.ts"
import type { IconName } from "@/components/icon"
import type { Tone } from "@/components/ui"

export const threadStatus: Record<ThreadStatus, { label: string; tone: Tone; icon?: IconName }> = {
  idle: { label: "Idle", tone: "neutral" },
  running: { label: "Running", tone: "running", icon: "RiLoader4Line" },
  awaiting_approval: { label: "Needs you", tone: "attention", icon: "RiErrorWarningLine" },
  limited: { label: "Limited", tone: "attention", icon: "RiErrorWarningLine" },
  archived: { label: "Archived", tone: "neutral", icon: "RiArchiveLine" },
}
