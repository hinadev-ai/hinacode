import { useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { type ComponentType, useId, useState } from "react"
import { RiClaudeFill, RiGrokAiFill, RiOpenaiFill } from "react-icons/ri"
import { toast } from "sonner"
import type { AppConnection, AppConnectionsStatus } from "../../../shared/domain.ts"
import type { RpcMethod, RpcRequest } from "../../../shared/contract.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { formatRelativeTime } from "../../lib/relativeTime.ts"
import { appConnectionsAtom, callPromise } from "../../lib/rpc.ts"
import { useNow } from "../../lib/useNow.ts"
import { m } from "../../paraglide/messages.js"
import { getLocale } from "../../paraglide/runtime.js"
import { Button } from "../ui/button.tsx"
import { Field, FieldError, FieldLabel } from "../ui/field.tsx"
import { CopyField } from "./automations/shared.tsx"
import { settingsSurfaceClass } from "./SettingsSection.tsx"

export function AppConnectionsSettings() {
  const status = useAtomValue(appConnectionsAtom)
  const headingId = useId()

  return (
    <section aria-labelledby={headingId} className={cn(settingsSurfaceClass, "flex flex-col gap-4 p-4")}>
      <h3 id={headingId} className="text-sm font-medium">
        {m.apps_title()}
      </h3>
      {AsyncResult.builder(status)
        .onSuccess(({ url, waitingUntil, requests, connections }) => (
          <div className="flex flex-col gap-4">
            {url === null ? (
              <p className="text-sm text-muted-foreground">{m.apps_needs_relay()}</p>
            ) : (
              <Endpoint url={url} waiting={waitingUntil !== null && requests.length === 0} />
            )}
            {requests.length > 0 && (
              <ul className="flex flex-col gap-2">
                {requests.map((request) => (
                  <RequestRow key={request.id} request={request} />
                ))}
              </ul>
            )}
            {connections.length > 0 && (
              <ul className="flex flex-col divide-y divide-border">
                {connections.map((connection) => (
                  <ConnectionRow key={connection.id} connection={connection} />
                ))}
              </ul>
            )}
          </div>
        ))
        .onError((cause) => <FieldError>{errorMessage(cause)}</FieldError>)
        .orElse(() => null)}
    </section>
  )
}

function useAppConnectionsAction() {
  const [error, setError] = useState<string | null>(null)
  const run =
    <M extends Extract<RpcMethod, `appConnections.${string}`>>(method: M, input: RpcRequest<M>) =>
    async () => {
      setError(null)
      try {
        await callPromise(method, input)
      } catch (cause) {
        setError(errorMessage(cause))
      }
    }
  return { error, run }
}

interface Handoff {
  readonly copy?: { readonly text: string; readonly toast: string }
  readonly open?: string
}

interface ConnectableApp {
  readonly name: string
  readonly icon?: ComponentType<{ className?: string }>
  readonly handoff: (url: string) => Handoff
}

const APPS: ReadonlyArray<ConnectableApp> = [
  {
    name: "Grok Bot",
    icon: RiGrokAiFill,
    handoff: (url) => ({
      copy: { text: `Add the MCP server ${url} and connect it.`, toast: m.apps_copied_message({ app: "Grok Bot" }) },
      open: "https://x.ai/bot",
    }),
  },
  {
    name: "Claude",
    icon: RiClaudeFill,
    handoff: (url) => ({
      open: `https://claude.ai/customize/connectors?${new URLSearchParams({
        modal: "add-custom-connector",
        connectorName: "HinaCode",
        connectorUrl: url,
      })}`,
    }),
  },
  {
    name: "ChatGPT",
    icon: RiOpenaiFill,
    handoff: (url) => ({
      copy: { text: url, toast: m.apps_copied_url({ app: "ChatGPT" }) },
      open: "https://chatgpt.com/plugins",
    }),
  },
  {
    name: "Hermes Agent",
    handoff: (url) => ({
      copy: {
        text: `hermes mcp add hinacode --url ${url} --auth oauth --connect-timeout 315`,
        toast: m.apps_copied_command({ app: "Hermes Agent" }),
      },
    }),
  },
]

function Endpoint({ url, waiting }: { url: string; waiting: boolean }) {
  const { error, run } = useAppConnectionsAction()

  const connect = (handoff: Handoff) => async () => {
    if (handoff.copy !== undefined) {
      await navigator.clipboard.writeText(handoff.copy.text)
      toast.success(handoff.copy.toast)
    }
    if (handoff.open !== undefined) window.open(handoff.open, "_blank", "noopener")
    await run("appConnections.start", undefined)()
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {APPS.map(({ name, icon: Icon, handoff }) => (
          <Button key={name} variant="outline" action={connect(handoff(url))}>
            {Icon !== undefined && <Icon aria-hidden />}
            {name}
          </Button>
        ))}
      </div>
      <Field className="min-w-0">
        <FieldLabel htmlFor="apps-url">{m.apps_url_label()}</FieldLabel>
        <CopyField id="apps-url" value={url} copyLabel={m.apps_url_copy()} />
      </Field>
      {waiting && <p className="text-sm text-muted-foreground">{m.apps_waiting()}</p>}
      {error && <FieldError>{error}</FieldError>}
    </>
  )
}

function RequestRow({ request }: { request: AppConnectionsStatus["requests"][number] }) {
  const { error, run } = useAppConnectionsAction()

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium" title={request.name}>
            {m.apps_request({ name: request.name })}
          </span>
          <span className="truncate text-sm text-muted-foreground" title={request.redirectHost}>
            {m.apps_request_returns({ host: request.redirectHost })}
          </span>
        </div>
        <Button variant="ghost" size="sm" action={run("appConnections.answer", { id: request.id, approve: false })}>
          {m.apps_deny()}
        </Button>
        <Button size="sm" action={run("appConnections.answer", { id: request.id, approve: true })}>
          {m.apps_approve()}
        </Button>
      </div>
      {error && <FieldError>{error}</FieldError>}
    </li>
  )
}

function ConnectionRow({ connection }: { connection: AppConnection }) {
  const { error, run } = useAppConnectionsAction()
  const now = useNow()

  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-sm" title={connection.name}>
          {connection.name}
        </span>
        <span className="text-sm whitespace-nowrap text-muted-foreground">
          {connection.lastUsedAt === null
            ? m.apps_connected({ time: formatRelativeTime(connection.createdAt, now, getLocale()) })
            : m.apps_last_used({ time: formatRelativeTime(connection.lastUsedAt, now, getLocale()) })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label={m.apps_remove_label({ name: connection.name })}
          action={run("appConnections.remove", { id: connection.id })}
        >
          {m.apps_remove()}
        </Button>
      </div>
      {error && <FieldError>{error}</FieldError>}
    </li>
  )
}
