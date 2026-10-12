import type { AgentEvent } from "../../shared/agent.ts"
import type { NotificationSettings, ThreadAlert } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"
import { router } from "../router.tsx"
import { useThreads } from "../stores/threads.ts"
import { notify } from "./notify.ts"

const alertFor = (event: AgentEvent): { readonly alert: ThreadAlert; readonly body: string } | undefined => {
  switch (event.type) {
    case "turn_completed":
      return { alert: "completed", body: m.notification_completed() }
    case "approval_requested":
      return { alert: "needsInput", body: m.notification_approval() }
    case "question_requested":
      return { alert: "needsInput", body: m.notification_question() }
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

const isOnScreen = (threadId: string) =>
  document.hasFocus() && router.matchRoute({ to: "/thread/$threadId", params: { threadId } }) !== false

const openThread = (threadId: string) => void router.navigate({ to: "/thread/$threadId", params: { threadId } })

/** Notifies about a thread the user is not looking at, when the event is one they turned on. */
export const notifyThreadEvent = (threadId: string, event: AgentEvent, settings: NotificationSettings) => {
  const raised = alertFor(event)
  const thread = useThreads.getState().byId[threadId]
  if (raised === undefined || thread === undefined || !settings[raised.alert] || isOnScreen(threadId)) return
  notify({
    ...raised,
    title: thread.title,
    sound: settings.sound,
    tag: threadId,
    onClick: () => openThread(threadId),
  })
}
