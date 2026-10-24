import { router, usePathname } from "expo-router"
import type { AgentEvent } from "@shared/agent.ts"
import { useEffect, useEffectEvent, useState } from "react"
import { AppState, Platform } from "react-native"
import { Banner, type BannerNotice } from "@/components/banner"
import { onEvent, useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import {
  getNotificationPermission,
  onNotificationOpened,
  presentNotification,
  requestNotificationPermission,
} from "@/lib/notifications"
import { outcomeOf } from "@/lib/row-state"
import { threadAlert } from "@/lib/thread-alerts"
import { usePreferences } from "@/stores/preferences"
import { useThreads } from "@/stores/threads"
import { useUnseen } from "@/stores/unseen"

const isViewing = (pathname: string, threadId: string) =>
  pathname === `/thread/${threadId}` || pathname.startsWith(`/thread/${threadId}/`)

let noticeCount = 0

const openThread = (id: string) => router.push({ pathname: "/thread/[id]", params: { id } })

/** Raises a banner or a system notification when a thread the developer is not looking at needs them. */
export function Notifier() {
  const pathname = usePathname()
  const paired = useConnection((state) => state.paired)
  const [notice, setNotice] = useState<BannerNotice | null>(null)

  const receive = useEffectEvent((threadId: string, alert: NonNullable<ReturnType<typeof threadAlert>>) => {
    if (!usePreferences.getState().notifications[alert.kind]) return
    const thread = useThreads.getState().byId[threadId]
    // A finished turn with messages queued behind it is not the end of the thread's work.
    if (alert.kind === "completed" && (thread?.queue.length ?? 0) > 0) return
    const title = thread === undefined || thread.title === "" ? copy("mobile_notify_untitled") : thread.title
    if (AppState.currentState !== "active") {
      void presentNotification({ threadId, title, body: alert.body })
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

  const opened = useEffectEvent((threadId: string) => {
    if (paired) openThread(threadId)
  })

  useEffect(
    () =>
      onEvent((event) => {
        if (event.type !== "thread.event") return
        recordOutcome(event.threadId, event.event)
        const alert = threadAlert(event.event)
        if (alert !== null) receive(event.threadId, alert)
      }),
    [],
  )

  useEffect(() => onNotificationOpened((threadId) => opened(threadId)), [])

  useEffect(() => {
    // Browsers only show the prompt after a tap, so the web asks from Settings instead.
    if (!paired || Platform.OS === "web") return
    void getNotificationPermission().then((permission) => {
      if (permission === "undetermined") void requestNotificationPermission()
    })
  }, [paired])

  return <Banner notice={notice} onOpen={openThread} onDismiss={() => setNotice(null)} />
}
