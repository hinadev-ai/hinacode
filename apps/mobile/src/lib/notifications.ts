export type NotificationPermission = "granted" | "denied" | "undetermined" | "unsupported"

/** Whether the system lets this app post notifications. */
export async function getNotificationPermission(): Promise<NotificationPermission> {
  return "unsupported"
}

/** Asks the system for permission, and resolves with the answer. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  return "unsupported"
}
