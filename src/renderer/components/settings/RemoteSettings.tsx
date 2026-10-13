import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import QRCode from "qrcode"
import { type FormEvent, useEffect, useId, useState, useTransition } from "react"
import type { RemotePairing } from "../../../shared/domain.ts"
import { pairingUrl } from "../../../shared/remote.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { callPromise, remotePairingAtom, remoteStatusAtom, updateSettingsAtom } from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx"
import { Input } from "../ui/input.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx"
import { Switch } from "../ui/switch.tsx"
import { CopyField } from "./automations/shared.tsx"
import { SettingsSection } from "./SettingsSection.tsx"

const LOOPBACK = "127.0.0.1"
const ALL_INTERFACES = "0.0.0.0"

type RemoteSettingsValue = ReturnType<typeof useSettings>["remote"]

export function RemoteSettings() {
  const { remote } = useSettings()
  const updateSettings = useAtomSet(updateSettingsAtom, { mode: "promise" })
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const save = (patch: Partial<RemoteSettingsValue>) =>
    startTransition(async () => {
      setError(null)
      try {
        await updateSettings({ remote: { ...remote, ...patch } })
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })

  return (
    <SettingsSection title={m.settings_remote()} description={m.remote_description()}>
      <div className="flex flex-col gap-3">
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="remote-enabled">{m.remote_enable_label()}</FieldLabel>
            <FieldDescription>{m.remote_enable_hint()}</FieldDescription>
          </FieldContent>
          <Switch
            id="remote-enabled"
            checked={remote.enabled}
            disabled={pending}
            onCheckedChange={(enabled) => save({ enabled })}
          />
        </Field>
        <RemoteStatusLine remote={remote} />
      </div>
      <ListenerSettings remote={remote} pending={pending} onSave={save} />
      {error && <FieldError>{error}</FieldError>}
      {remote.enabled && <PairPhone fallbackHost={remote.bindHost} />}
    </SettingsSection>
  )
}

function StatusDot({ className }: { className: string }) {
  return <span aria-hidden className={cn("size-2 shrink-0 rounded-full", className)} />
}

function RemoteStatusLine({ remote }: { remote: RemoteSettingsValue }) {
  return (
    <p aria-live="polite" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      {remote.enabled ? <ListenerStatus remote={remote} /> : <OffStatus />}
    </p>
  )
}

function OffStatus() {
  return (
    <span className="flex items-center gap-2 text-muted-foreground">
      <StatusDot className="bg-muted-foreground/50" />
      {m.remote_status_off()}
    </span>
  )
}

function ListenerStatus({ remote }: { remote: RemoteSettingsValue }) {
  const status = useAtomValue(remoteStatusAtom)

  return AsyncResult.builder(status)
    .onInitial(() => <span className="text-muted-foreground">{m.remote_status_checking()}</span>)
    .onSuccess(({ listening, listenError, connected }) => {
      if (listenError !== null)
        return (
          <span className="flex items-center gap-2 text-destructive">
            <StatusDot className="bg-destructive" />
            {m.remote_status_error({ message: listenError })}
          </span>
        )
      if (!listening) return <span className="text-muted-foreground">{m.remote_status_starting()}</span>
      return (
        <>
          <span className="flex items-center gap-2">
            <StatusDot className="bg-emerald-500" />
            {m.remote_status_listening({ address: `${remote.bindHost}:${remote.port}` })}
          </span>
          <span className="text-muted-foreground tabular-nums">{m.remote_status_connected({ count: connected })}</span>
        </>
      )
    })
    .onError((cause) => <span className="text-destructive">{errorMessage(cause)}</span>)
    .orElse(() => null)
}

interface ListenerSettingsProps {
  readonly remote: RemoteSettingsValue
  readonly pending: boolean
  readonly onSave: (patch: Partial<RemoteSettingsValue>) => void
}

function ListenerSettings({ remote, pending, onSave }: ListenerSettingsProps) {
  const [port, setPort] = useState(String(remote.port))
  const hostItems = [
    { value: LOOPBACK, label: m.remote_bind_loopback() },
    { value: ALL_INTERFACES, label: m.remote_bind_all() },
  ]

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSave({ port: Number(port) })
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-64">
          <FieldLabel htmlFor="remote-bind-host">{m.remote_bind_label()}</FieldLabel>
          <Select
            items={hostItems}
            value={remote.bindHost}
            onValueChange={(next) => typeof next === "string" && onSave({ bindHost: next })}
          >
            <SelectTrigger id="remote-bind-host" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {hostItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <form onSubmit={onSubmit} className="flex items-end gap-2">
          <Field className="w-28">
            <FieldLabel htmlFor="remote-port">{m.remote_port_label()}</FieldLabel>
            <Input
              id="remote-port"
              type="number"
              min={1}
              max={65535}
              required
              value={port}
              onChange={(event) => setPort(event.target.value)}
              className="font-mono tabular-nums"
            />
          </Field>
          <Button type="submit" variant="outline" disabled={pending || Number(port) === remote.port}>
            {m.settings_save()}
          </Button>
        </form>
      </div>
      <FieldDescription>
        {remote.bindHost === ALL_INTERFACES ? m.remote_bind_all_hint() : m.remote_bind_loopback_hint()}
      </FieldDescription>
      <FieldDescription>{m.remote_network_note()}</FieldDescription>
    </div>
  )
}

function PairPhone({ fallbackHost }: { fallbackHost: string }) {
  const pairing = useAtomValue(remotePairingAtom)
  const refresh = useAtomRefresh(remotePairingAtom)
  const headingId = useId()

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <h3 id={headingId} className="text-sm font-medium">
        {m.remote_pair_title()}
      </h3>
      {AsyncResult.builder(pairing)
        .onInitial(() => <p className="text-sm text-muted-foreground">{m.remote_pair_loading()}</p>)
        .onSuccess((value) => <PairingDetails pairing={value} fallbackHost={fallbackHost} onRotated={refresh} />)
        .onError((cause) => (
          <div className="flex items-center gap-2">
            <p className="text-sm text-destructive">{m.remote_pair_failed({ message: errorMessage(cause) })}</p>
            <Button variant="ghost" size="sm" onClick={refresh}>
              {m.common_retry()}
            </Button>
          </div>
        ))
        .orElse(() => null)}
    </section>
  )
}

interface PairingDetailsProps {
  readonly pairing: RemotePairing
  readonly fallbackHost: string
  readonly onRotated: () => void
}

function PairingDetails({ pairing, fallbackHost, onRotated }: PairingDetailsProps) {
  const [chosenHost, setChosenHost] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const host =
    chosenHost !== null && pairing.hosts.includes(chosenHost) ? chosenHost : (pairing.hosts[0] ?? fallbackHost)
  const url = pairingUrl(host, pairing.port, pairing.token)
  const hostItems = pairing.hosts.map((value) => ({ value, label: value }))

  const rotate = () =>
    startTransition(async () => {
      setError(null)
      try {
        await callPromise("remote.rotateToken", undefined)
        onRotated()
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })

  return (
    <div className="flex flex-col gap-4">
      {hostItems.length > 0 && (
        <Field className="w-64">
          <FieldLabel htmlFor="remote-pair-host">{m.remote_pair_host_label()}</FieldLabel>
          <Select
            items={hostItems}
            value={host}
            onValueChange={(next) => typeof next === "string" && setChosenHost(next)}
          >
            <SelectTrigger id="remote-pair-host" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {hostItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  <span className="font-mono">{item.label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>{m.remote_pair_host_hint()}</FieldDescription>
        </Field>
      )}
      <PairingQrCode url={url} />
      <Field className="min-w-0">
        <FieldLabel htmlFor="remote-pair-url">{m.remote_pair_url_label()}</FieldLabel>
        <CopyField id="remote-pair-url" value={url} copyLabel={m.remote_pair_url_copy()} />
        <FieldDescription>{m.remote_pair_token_hint()}</FieldDescription>
      </Field>
      <div className="flex flex-col items-start gap-2">
        <Button variant="outline" disabled={pending} onClick={rotate}>
          {m.remote_rotate()}
        </Button>
        <FieldDescription>{m.remote_rotate_hint()}</FieldDescription>
        {error && <FieldError>{error}</FieldError>}
      </div>
    </div>
  )
}

function PairingQrCode({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void QRCode.toString(url, { type: "svg", margin: 1 }).then(
      (svg) => current && setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`),
    )
    return () => {
      current = false
    }
  }, [url])

  // Scanners need dark modules on a light ground, so the code stays black on white in every theme.
  return (
    <div className="size-48 rounded-md bg-white p-2">
      {src && <img src={src} alt={m.remote_pair_qr_label()} className="size-full" />}
    </div>
  )
}
