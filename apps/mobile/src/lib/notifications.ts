import * as Notifications from "expo-notifications"
import { AndroidImportance, IosAuthorizationStatus } from "expo-notifications"
import { Platform } from "react-native"
import { copy } from "@/lib/copy"

export type NotificationPermission = "granted" | "denied" | "undetermined" | "unsupported"

export interface ThreadNotification {
  readonly threadId: string
  readonly title: string
  readonly body: string
}

const CHANNEL_ID = "threads"

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
})

let channel: Promise<unknown> | null = null

// FIXME: Android 13 only shows the permission prompt once a notification channel exists.
const ensureChannel = () => {
  if (Platform.OS !== "android") return Promise.resolve()
  channel ??= Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: copy("mobile_notify_channel"),
    importance: AndroidImportance.HIGH,
  })
  return channel
}

const toPermission = (status: Notifications.NotificationPermissionsStatus): NotificationPermission => {
  if (status.granted || status.ios?.status === IosAuthorizationStatus.PROVISIONAL) return "granted"
  return status.status === "denied" ? "denied" : "undetermined"
}

export async function getNotificationPermission(): Promise<NotificationPermission> {
  return toPermission(await Notifications.getPermissionsAsync())
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  await ensureChannel()
  return toPermission(await Notifications.requestPermissionsAsync())
}

export async function presentNotification({ threadId, title, body }: ThreadNotification) {
  await ensureChannel()
  await Notifications.scheduleNotificationAsync({
    identifier: threadId,
    content: { title, body, data: { threadId } },
    trigger: Platform.OS === "android" ? { channelId: CHANNEL_ID } : null,
  })
}

export function onNotificationOpened(listener: (threadId: string) => void): () => void {
  let active = true
  let opened: string | null = null
  const open = (response: Notifications.NotificationResponse | null) => {
    if (!active || response === null) return
    const { request, date } = response.notification
    const threadId = request.content.data?.threadId
    // FIXME: expo-notifications can deliver the tap that launched the app through both the listener and the last response.
    const key = `${request.identifier}:${date}`
    if (typeof threadId !== "string" || key === opened) return
    opened = key
    // FIXME: the launch response stays readable until cleared, so a remount would open the thread again.
    Notifications.clearLastNotificationResponse()
    listener(threadId)
  }
  const subscription = Notifications.addNotificationResponseReceivedListener(open)
  void Notifications.getLastNotificationResponseAsync().then(open)
  return () => {
    active = false
    subscription.remove()
  }
}
