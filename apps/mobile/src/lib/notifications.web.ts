export type NotificationPermission = "granted" | "denied" | "undetermined" | "unsupported"

export interface ThreadNotification {
  readonly threadId: string
  readonly title: string
  readonly body: string
}

const listeners = new Set<(threadId: string) => void>()

const supported = () => typeof window !== "undefined" && "Notification" in window

const toPermission = (permission: typeof Notification.permission): NotificationPermission =>
  permission === "default" ? "undetermined" : permission

export async function getNotificationPermission(): Promise<NotificationPermission> {
  return supported() ? toPermission(Notification.permission) : "unsupported"
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  return supported() ? toPermission(await Notification.requestPermission()) : "unsupported"
}

export async function presentNotification({ threadId, title, body }: ThreadNotification) {
  if (!supported() || Notification.permission !== "granted") return
  try {
    const notification = new Notification(title, { body, tag: threadId })
    notification.onclick = () => {
      window.focus()
      notification.close()
      for (const listener of listeners) listener(threadId)
    }
  } catch {
    // FIXME: Chrome on Android only posts notifications from a service worker, and this page has none.
  }
}

export function onNotificationOpened(listener: (threadId: string) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
