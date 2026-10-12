import { Duration, Effect } from "effect"
import { Notification } from "electron"
import { createRequire } from "node:module"
import type { NotificationPermission, PermissionRequestOutcome } from "../shared/domain.ts"

const require = createRequire(import.meta.url)

/**
 * Electron has no API for this, and on macOS a denied notification fails silently.
 * `node-mac-permissions` is an optional dependency that only installs on macOS.
 */
export const notificationPermission: Effect.Effect<NotificationPermission> = Effect.sync(() => {
  if (process.platform !== "darwin") return "unknown"
  // CommonJS without named exports Node can detect, so an ESM import would see none.
  // Keep the optional, darwin-only package out of TypeScript resolution on Linux and Windows.
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

/**
 * Shows one notification from main, which makes macOS ask the user if it has not yet. Main's `failed`
 * event is the only reliable sign that macOS refused, since renderer notifications fail without an event.
 */
export const askNotificationPermission = (title: string, body: string) =>
  Effect.callback<PermissionRequestOutcome>((resume) => {
    const notification = new Notification({ title, body, silent: true })
    notification.once("show", () => resume(Effect.succeed("shown")))
    notification.once("failed", () => resume(Effect.succeed("refused")))
    notification.show()
  }).pipe(Effect.timeoutOrElse({ duration: Duration.seconds(10), orElse: () => Effect.succeed("noAnswer" as const) }))
