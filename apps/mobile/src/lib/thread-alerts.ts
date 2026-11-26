import type { AgentEvent } from "@shared/agent.ts"
import type { ThreadVm } from "@shared/domain.ts"
import { copy } from "@/lib/copy"
import { handOverRequest } from "@/lib/vm"

export type AlertKind = "completed" | "needsInput" | "failed"

export interface ThreadAlert {
  readonly kind: AlertKind
  readonly body: string
}

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
      if (event.stopped) return null
      return { kind: "failed", body: copy("mobile_notify_failed", { message: event.message.split("\n")[0] ?? "" }) }
    case "turn_limited":
      return { kind: "failed", body: copy("mobile_notify_limited") }
    default:
      return null
  }
}

export function handOverAlert(previous: ThreadVm | undefined, next: ThreadVm): ThreadAlert | null {
  const request = handOverRequest(next)
  if (request === undefined || request === handOverRequest(previous ?? null)) return null
  return { kind: "needsInput", body: copy("mobile_notify_vm", { request }) }
}
