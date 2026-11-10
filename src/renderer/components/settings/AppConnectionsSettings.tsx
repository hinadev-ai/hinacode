import { useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { useId, useState } from "react"
import type { AppConnection, AppConnectionsStatus } from "../../../shared/domain.ts"
import type { RpcMethod, RpcRequest } from "../../../shared/contract.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { formatRelativeTime } from "../../lib/relativeTime.ts"
import { appConnectionsAtom, callPromise } from "../../lib/rpc.ts"
import { useNow } from "../../lib/useNow.ts"
import { m } from "../../paraglide/messages.js"
import { getLocale } from "../../paraglide/runtime.js"
import { Button } from "../ui/button.tsx"
import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx"
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
        .onSuccess(({ url, approvalCode, connections }) => (
          <div className="flex flex-col gap-4">
            {url === null ? (
              <p className="text-sm text-muted-foreground">{m.apps_needs_relay()}</p>
            ) : (
              <Endpoint url={url} approvalCode={approvalCode} />
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

function Endpoint({ url, approvalCode }: Pick<AppConnectionsStatus, "approvalCode"> & { url: string }) {
  const { error, run } = useAppConnectionsAction()

  return (
    <>
      <Field className="min-w-0">
        <FieldLabel htmlFor="apps-url">{m.apps_url_label()}</FieldLabel>
        <CopyField id="apps-url" value={url} copyLabel={m.apps_url_copy()} />
      </Field>
      {approvalCode !== null && (
        <Field className="min-w-0">
          <FieldLabel htmlFor="apps-code">{m.apps_code_label()}</FieldLabel>
          <CopyField id="apps-code" value={approvalCode.code} copyLabel={m.apps_code_copy()} />
          <FieldDescription>{m.apps_code_expires({ time: formatClock(approvalCode.expiresAt) })}</FieldDescription>
        </Field>
      )}
      <div className="flex flex-col items-start gap-2">
        <Button variant="outline" action={run("appConnections.newApprovalCode", undefined)}>
          {m.apps_new_code()}
        </Button>
        {error && <FieldError>{error}</FieldError>}
      </div>
    </>
  )
}

const formatClock = (iso: string) => new Intl.DateTimeFormat(getLocale(), { timeStyle: "short" }).format(new Date(iso))

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
