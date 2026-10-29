import { router, usePathname } from "expo-router"
import type { AgentEvent } from "@shared/agent.ts"
import { threadLink } from "@shared/links.ts"
import { outcomeOf } from "@shared/threadStatus.ts"
import { useEffect, useEffectEvent, useState } from "react"
import { AppState, Platform } from "react-native"
import { Banner, type BannerNotice } from "@/components/banner"
import { onEvent, useConnection } from "@/lib/connection"
import { routeForLink } from "@/lib/links"
import { copy } from "@/lib/copy"
import { openThread } from "@/lib/navigation"
import {
  getNotificationPermission,
  onNotificationOpened,
  type OpenedThread,
  presentNotification,
  requestNotificationPermission,
} from "@/lib/notifications"
import { shouldPresentLocal } from "@/lib/push"
import { type ThreadAlert, threadAlert } from "@/lib/thread-alerts"
import { usePreferences } from "@/stores/preferences"
import { pushRegistered, useRelayAccount } from "@/stores/relay-account"
import { useThreads } from "@/stores/threads"
import { useUnseen } from "@/stores/unseen"

const isViewing = (pathname: string, threadId: string) =>
  pathname === `/thread/${threadId}` || pathname.startsWith(`/thread/${threadId}/`)

let noticeCount = 0

/** Raises a banner or a system notification when a thread the developer is not looking at needs them. */
export function Notifier() {
  const pathname = usePathname()
  const paired = useConnection((state) => state.paired)
  const [notice, setNotice] = useState<BannerNotice | null>(null)

  const receive = useEffectEvent((serverId: string, threadId: string, alert: ThreadAlert) => {
    if (!usePreferences.getState().notifications[alert.kind]) return
    const thread = useThreads.getState().byId[threadId]
    // A finished turn with messages queued behind it is not the end of the thread's work.
    if (alert.kind === "completed" && (thread?.queue.length ?? 0) > 0) return
    const title = thread === undefined || thread.title === "" ? copy("mobile_notify_untitled") : thread.title
    if (AppState.currentState !== "active") {
      const server = useConnection.getState().servers.find((candidate) => candidate.id === serverId)
      if (shouldPresentLocal({ pushRegistered: pushRegistered(), server }))
        void presentNotification({ threadId, environmentId: server?.environmentId ?? null, title, body: alert.body })
    } else if (!isViewing(pathname, threadId)) {
      noticeCount += 1
      setNotice({ id: noticeCount, threadId, kind: alert.kind, title, body: alert.body })
    }
  })

  // Marks a thread whose turn ended out of sight, for the row's dot; opening the thread clears it.
  const recordOutcome = useEffectEvent((threadId: string, event: AgentEvent) => {
    const outcome = outcomeOf(event)
    if (outcome === undefined) return
    const continues = event.type === "turn_completed" && (useThreads.getState().byId[threadId]?.queue.length ?? 0) > 0
    if (continues || (AppState.currentState === "active" && isViewing(pathname, threadId))) return
    useUnseen.getState().record(threadId, outcome)
  })

  const opened = useEffectEvent(({ threadId, environmentId }: OpenedThread) => {
    if (!paired) return
    if (environmentId === null) return openThread(threadId)
    const environmentIds = useConnection.getState().servers.map((server) => server.environmentId)
    const href = routeForLink(threadLink(environmentId, threadId), { paired, environmentIds })
    if (href === "/") router.navigate("/")
    else openThread(threadId)
  })

  useEffect(
    () =>
      onEvent((event, serverId) => {
        if (event.type !== "thread.event") return
        recordOutcome(event.threadId, event.event)
        const alert = threadAlert(event.event)
        if (alert !== null) receive(serverId, event.threadId, alert)
      }),
    [],
  )

  useEffect(() => onNotificationOpened((thread) => opened(thread)), [])

  useEffect(() => {
    // Browsers only show the prompt after a tap, so the web asks from Settings instead.
    if (!paired || Platform.OS === "web") return
    void getNotificationPermission().then((permission) => {
      if (permission !== "undetermined") return
      void requestNotificationPermission().then((answer) => {
        if (answer === "granted") void useRelayAccount.getState().registerPush()
      })
    })
  }, [paired])

  return <Banner notice={notice} onOpen={openThread} onDismiss={() => setNotice(null)} />
}
