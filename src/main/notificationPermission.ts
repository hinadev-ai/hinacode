import { Duration, Effect } from "effect"
import { Notification } from "electron"
import { createRequire } from "node:module"
import type { NotificationPermission, PermissionRequestOutcome } from "../shared/domain.ts"

const require = createRequire(import.meta.url)

// FIXME: Electron cannot read notification permission, and macOS fails denied notifications silently
export const notificationPermission: Effect.Effect<NotificationPermission> = Effect.sync(() => {
  if (process.platform !== "darwin") return "unknown"
  // FIXME: the darwin-only CommonJS package has no named exports ESM can detect, nor types off macOS
  const { getAuthStatus } = require("node-mac-permissions") as { getAuthStatus(type: "notifications"): string }
  const status = getAuthStatus("notifications")
  switch (status) {
    case "authorized":
    case "provisional":
      return "granted"
    case "denied":
    case "restricted":
      return "denied"
    case "not determined":
      return "notDetermined"
    default:
      return "unknown"
  }
}).pipe(Effect.catchDefect(() => Effect.succeed("unknown" as const)))

// FIXME: only main's `failed` event shows macOS refused; renderer notifications fail silently
export const askNotificationPermission = (title: string, body: string) =>
  Effect.callback<PermissionRequestOutcome>((resume) => {
    const notification = new Notification({ title, body, silent: true })
    notification.once("show", () => resume(Effect.succeed("shown")))
    notification.once("failed", () => resume(Effect.succeed("refused")))
    notification.show()
  }).pipe(Effect.timeoutOrElse({ duration: Duration.seconds(10), orElse: () => Effect.succeed("noAnswer" as const) }))
