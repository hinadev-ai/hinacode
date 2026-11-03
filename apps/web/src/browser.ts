import { Option, Schema } from "effect"
import type { PushEvent, RpcEnvelope, RpcMethod } from "../../../src/shared/contract.ts"
import {
  ClientSettings,
  defaultClientSettings,
  type EnvironmentStatus,
  type NotificationPermission,
} from "../../../src/shared/domain.ts"
import type { RelayHost, RelayMachine } from "../../../src/shared/relayMachines.ts"
import { m } from "@/paraglide/messages.js"
import type { RelayAccount } from "./account.ts"

const CLIENT_SETTINGS_KEY = "hinacode.clientSettings"
const LINE_COMMENTS = "hinacode.lineComments"

const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(ClientSettings))
const encodeSettings = Schema.encodeSync(ClientSettings)

export const readSettings = () =>
  Option.getOrElse(decodeSettings(localStorage.getItem(CLIENT_SETTINGS_KEY) ?? ""), () => defaultClientSettings)

const permission = (): NotificationPermission => {
  if (!("Notification" in window)) return "unknown"
  return Notification.permission === "default" ? "notDetermined" : Notification.permission
}

export interface BrowserContext {
  readonly account: RelayAccount
  readonly machines: ReadonlyArray<RelayMachine>
  readonly statusOf: (environmentId: string) => EnvironmentStatus
  readonly reconnect: (environmentId: string) => void
  readonly emit: (event: typeof PushEvent.Encoded) => void
  readonly signOut: () => void
}

const pageTitle = document.title

export const makeBrowserAnswers = (context: BrowserContext) => {
  const lineComments = new BroadcastChannel(LINE_COMMENTS)
  lineComments.addEventListener("message", (message: MessageEvent<typeof PushEvent.Encoded>) =>
    context.emit(message.data),
  )

  const relay = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${context.account.serviceUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${context.account.ownerToken}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const answer: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined)
    if (response.ok) return answer
    const reason = (answer as { error?: unknown } | undefined)?.error
    throw new Error(typeof reason === "string" ? reason : m.web_relay_bad_status({ status: String(response.status) }))
  }

  const hosts = async () => ((await relay("GET", "/v1/hosts")) as { hosts: ReadonlyArray<RelayHost> }).hosts

  const relayStatus = () => ({
    state: "signedIn" as const,
    serviceUrl: context.account.serviceUrl,
    environmentId: "",
    machines: context.machines.length,
    syncedAt: null,
    error: null,
  })

  const answers: Partial<Record<RpcMethod, (payload: never) => unknown>> = {
    "app.ready": () => undefined,
    "app.setColorScheme": () => undefined,
    "artifacts.setTheme": () => undefined,
    "app.focus": () => window.focus(),
    "app.setBadgeCount": ({ count }: { count: number }) => {
      document.title = count > 0 ? `(${count}) ${pageTitle}` : pageTitle
    },
    "clientSettings.get": () => encodeSettings(readSettings()),
    "clientSettings.set": (patch: Partial<typeof ClientSettings.Encoded>) => {
      const next = { ...encodeSettings(readSettings()), ...patch }
      localStorage.setItem(CLIENT_SETTINGS_KEY, JSON.stringify(next))
      return next
    },
    "notifications.permission": permission,
    "notifications.askPermission": async ({ title, body }: { title: string; body: string }) => {
      if (!("Notification" in window)) return "refused"
      const answer = await Notification.requestPermission()
      if (answer !== "granted") return answer === "denied" ? "refused" : "noAnswer"
      const shown = new Notification(title, { body })
      shown.addEventListener("click", () => window.focus())
      return "shown"
    },
    "shell.openers": () => [],
    "agents.updates": () => [],
    "environments.list": () => ({
      clouds: context.machines.map((machine) => ({
        id: machine.environmentId,
        name: machine.name,
        host: machine.pairing.hosts[0],
        port: machine.pairing.port,
        relay: machine.pairing.relay,
        source: "relay",
        createdAt: new Date(0).toISOString(),
        status: context.statusOf(machine.environmentId),
        lastSeenAt: null,
      })),
    }),
    "environments.reconnect": ({ id }: { id: string }) => context.reconnect(id),
    "relayAccount.status": relayStatus,
    "relayAccount.sync": () => {
      location.reload()
      return relayStatus()
    },
    "relayAccount.signOut": () => {
      context.signOut()
      return { state: "signedOut" }
    },
    "relayAccount.machines": hosts,
    "relayAccount.setShown": async ({ id, enabled }: { id: string; enabled: boolean }) => {
      await relay("PATCH", `/v1/hosts/${encodeURIComponent(id)}`, { enabled })
      return hosts()
    },
    "relayAccount.removeMachine": async ({ id }: { id: string }) => {
      await relay("DELETE", `/v1/hosts/${encodeURIComponent(id)}`)
      return hosts()
    },
    "windows.openPullRequest": ({ threadId, url }: { threadId: string; url: string }) => {
      const entry = `/thread/${encodeURIComponent(threadId)}/pull-request?${new URLSearchParams({ url })}`
      window.open(`${location.pathname}?${new URLSearchParams({ entry })}`, "_blank")
    },
    "windows.addLineComment": ({ threadId, comment }: { threadId: string; comment: unknown }) =>
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      lineComments.postMessage({ type: "thread.lineComment", threadId, comment }),
  }

  return (method: RpcMethod, payload: unknown): Promise<RpcEnvelope<unknown>> | undefined => {
    const answer = answers[method]
    if (answer === undefined) return undefined
    return Promise.resolve()
      .then(() => answer(payload as never))
      .then(
        (result) => ({ result }),
        (cause: unknown) => ({
          error: { tag: "BrowserError", message: cause instanceof Error ? cause.message : String(cause) },
        }),
      )
  }
}
