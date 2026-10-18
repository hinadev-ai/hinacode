import type { AgentEvent } from "@shared/agent.ts"
import { copy } from "@/lib/copy"

/** Matches the keys of the notification preferences, so each kind can be turned off on its own. */
export type AlertKind = "completed" | "needsInput" | "failed"

export interface ThreadAlert {
  readonly kind: AlertKind
  readonly body: string
}

/** The notice an agent event raises, the same table as the desktop's. Most events raise none. */
export function threadAlert(event: AgentEvent): ThreadAlert | null {
  switch (event.type) {
    case "turn_completed":
      return { kind: "completed", body: copy("mobile_notify_completed") }
    case "approval_requested":
      return { kind: "needsInput", body: copy("mobile_notify_approval") }
    case "question_requested":
      return { kind: "needsInput", body: copy("mobile_notify_question") }
    case "secret_requested":
      return { kind: "needsInput", body: copy("mobile_notify_secret") }
    case "turn_failed":
      return { kind: "failed", body: copy("mobile_notify_failed", { message: event.message.split("\n")[0] ?? "" }) }
    case "turn_limited":
      return { kind: "failed", body: copy("mobile_notify_limited") }
    default:
      return null
  }
}
