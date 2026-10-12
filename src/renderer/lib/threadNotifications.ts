import type { AgentEvent } from "../../shared/agent.ts"
import type { NotificationSettings, ThreadAlert } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"
import { router } from "../router.tsx"
import { useThreads } from "../stores/threads.ts"
import { notify, type Surface } from "./notify.ts"

const alertFor = (event: AgentEvent): { readonly alert: ThreadAlert; readonly body: string } | undefined => {
  switch (event.type) {
    case "turn_completed":
      return { alert: "completed", body: m.notification_completed() }
    case "approval_requested":
      return { alert: "needsInput", body: m.notification_approval() }
    case "secret_requested":
      return { alert: "needsInput", body: m.notification_secret() }
    case "turn_failed":
      return { alert: "failed", body: m.notification_failed({ message: event.message.split("\n")[0] ?? "" }) }
    case "turn_limited":
      return { alert: "failed", body: m.notification_limited() }
    default:
      return undefined
  }
}

const isOpen = (threadId: string) => router.matchRoute({ to: "/thread/$threadId", params: { threadId } }) !== false

/** Where the user's attention is decides the surface. The thread they are looking at needs no notice. */
const surfaceFor = (threadId: string): Surface | null => {
  if (!document.hasFocus()) return "desktop"
  return isOpen(threadId) ? null : "toast"
}

const openThread = (threadId: string) => void router.navigate({ to: "/thread/$threadId", params: { threadId } })

/** Notifies about a thread the user is not looking at, when the event is one they turned on. */
export const notifyThreadEvent = (threadId: string, event: AgentEvent, settings: NotificationSettings) => {
  const raised = alertFor(event)
  const thread = useThreads.getState().byId[threadId]
  if (raised === undefined || thread === undefined || !settings[raised.alert]) return
  const surface = surfaceFor(threadId)
  if (surface === null) return
  notify(surface, {
    ...raised,
    title: thread.title,
    sound: settings.sound,
    tag: threadId,
    onClick: () => openThread(threadId),
  })
}
