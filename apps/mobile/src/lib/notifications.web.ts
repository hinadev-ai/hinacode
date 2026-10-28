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

/** Whether the browser lets this page post notifications. */
export async function getNotificationPermission(): Promise<NotificationPermission> {
  return supported() ? toPermission(Notification.permission) : "unsupported"
}

/** Asks the browser for permission. Call it from a tap, since browsers ignore requests without a user gesture. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  return supported() ? toPermission(await Notification.requestPermission()) : "unsupported"
}

/** The web gets no pushes. */
export async function getPushToken(): Promise<string | null> {
  return null
}

/** Shows a browser notification when allowed. A newer one for the same thread replaces the older. */
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
    // Chrome on Android only posts notifications from a service worker, and this page has none.
  }
}

/** Reports the thread of each notification the developer clicks. Returns the unsubscribe function. */
export function onNotificationOpened(listener: (threadId: string) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
