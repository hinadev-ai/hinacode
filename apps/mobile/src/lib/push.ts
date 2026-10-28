import Constants from "expo-constants"
import type { Server } from "./connection"
import type { Preferences } from "./preferences"
import type { RelayAccount } from "./relay-account"
import type { AlertKind } from "./thread-alerts"

/** The EAS project `eas init` writes into app.json. Without one Expo issues no push token. */
export function pushProjectId(): string | null {
  const projectId: unknown = Constants.expoConfig?.extra?.eas?.projectId
  return typeof projectId === "string" && projectId !== "" ? projectId : null
}

export const alertsOf = (notifications: Preferences["notifications"]): AlertKind[] =>
  (Object.keys(notifications) as AlertKind[]).filter((kind) => notifications[kind])

async function sendDevice(
  account: RelayAccount,
  method: "PUT" | "DELETE",
  body: object,
  fetch: typeof globalThis.fetch,
) {
  try {
    const response = await fetch(`${account.serviceUrl.replace(/\/+$/, "")}/v1/devices`, {
      method,
      headers: { Authorization: `Bearer ${account.ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    return response.ok
  } catch {
    return false
  }
}

/** Asks the relay to push the kinds in `alerts` to this phone. Resolves with whether it agreed. */
export const registerDevice = (
  account: RelayAccount,
  token: string,
  alerts: readonly AlertKind[],
  fetch: typeof globalThis.fetch,
) => sendDevice(account, "PUT", { token, alerts }, fetch)

export const unregisterDevice = (account: RelayAccount, token: string, fetch: typeof globalThis.fetch) =>
  sendDevice(account, "DELETE", { token }, fetch)

/** A push about a machine whose socket is open stays quiet, since the socket already raised a banner for it. */
export function shouldShowPush(data: unknown, servers: readonly Pick<Server, "environmentId" | "status">[]): boolean {
  const environmentId =
    typeof data === "object" && data !== null ? (data as { environmentId?: unknown }).environmentId : undefined
  if (typeof environmentId !== "string") return true
  return !servers.some((server) => server.environmentId === environmentId && server.status === "connected")
}

/** In the background a machine with a relay pushes to a registered phone, so a local notification would repeat it. */
export const shouldPresentLocal = ({
  pushRegistered,
  server,
}: {
  readonly pushRegistered: boolean
  readonly server: Pick<Server, "relay"> | undefined
}) => !(pushRegistered && server !== undefined && server.relay !== null)
