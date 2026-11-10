import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { Effect } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import QRCode from "qrcode"
import { type FormEvent, useId, useState, useTransition } from "react"
import { PRIVATE_NETWORKS, type RemotePairing } from "../../../shared/domain.ts"
import { isPortInUse, pairingUrl } from "../../../shared/remote.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { callPromise, remotePairingAtom, remoteStatusAtom, updateSettingsAtom } from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx"
import { Input } from "../ui/input.tsx"
import { Switch } from "../ui/switch.tsx"
import { AppConnectionsSettings } from "./AppConnectionsSettings.tsx"
import { BindHostSelect, LOOPBACK } from "./BindHostSelect.tsx"
import { CopyField } from "./automations/shared.tsx"
import { SettingsGroup, SettingsSection, settingsSurfaceClass } from "./SettingsSection.tsx"

type RemoteSettingsValue = ReturnType<typeof useSettings>["remote"]

export function RemoteSettings() {
  const { remote } = useSettings(null)
  const updateSettings = useAtomSet(updateSettingsAtom(null), { mode: "promise" })
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const save = (next: RemoteSettingsValue) =>
    startTransition(async () => {
      setError(null)
      try {
        await updateSettings({ remote: next })
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })

  return (
    <SettingsSection title={m.settings_remote()} description={m.remote_description()}>
      <SettingsGroup>
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
              onCheckedChange={(enabled) => save({ ...remote, enabled })}
            />
          </Field>
          <RemoteStatusLine remote={remote} />
          <RelayStatusLine />
        </div>
        <ListenerSettings remote={remote} pending={pending} onSave={save} />
      </SettingsGroup>
      {error && <FieldError>{error}</FieldError>}
      {remote.enabled && <PairPhone />}
      <AppConnectionsSettings />
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
            {isPortInUse(listenError)
              ? m.remote_status_port_in_use({ port: remote.port })
              : m.remote_status_error({ message: listenError })}
          </span>
        )
      if (!listening) return <span className="text-muted-foreground">{m.remote_status_starting()}</span>
      return (
        <>
          <span className="flex items-center gap-2">
            <StatusDot className="bg-success" />
            {remote.bindHost === PRIVATE_NETWORKS
              ? m.remote_status_listening_private({ port: remote.port })
              : m.remote_status_listening({ address: `${remote.bindHost}:${remote.port}` })}
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
  readonly onSave: (next: RemoteSettingsValue) => void
}

function ListenerSettings({ remote, pending, onSave }: ListenerSettingsProps) {
  const [port, setPort] = useState(String(remote.port))

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSave({ ...remote, port: Number(port) })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-64">
          <FieldLabel htmlFor="remote-bind-host">{m.remote_bind_label()}</FieldLabel>
          <BindHostSelect
            id="remote-bind-host"
            environment={null}
            value={remote.bindHost}
            onChange={(bindHost) => onSave({ ...remote, bindHost })}
            privateNetworks
          />
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
        {remote.bindHost === LOOPBACK
          ? m.remote_bind_loopback_hint()
          : remote.bindHost === PRIVATE_NETWORKS
            ? m.remote_bind_private_hint()
            : m.remote_bind_address_hint({ address: remote.bindHost })}
      </FieldDescription>
      <FieldDescription>{m.remote_network_note()}</FieldDescription>
    </div>
  )
}

function RelayStatusLine() {
  const status = useAtomValue(remoteStatusAtom)
  if (!AsyncResult.isSuccess(status)) return null
  const { relay } = status.value
  if (relay.state === "off" || relay.state === "linking") return null

  return (
    <div aria-live="polite" className="flex flex-col gap-1 text-sm">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {relay.state === "connected" && (
          <span className="flex items-center gap-2">
            <StatusDot className="bg-success" />
            {m.relay_status_connected({ hostname: relay.hostname })}
          </span>
        )}
        {relay.state === "connecting" && (
          <span className="flex items-center gap-2 text-muted-foreground">
            <StatusDot className="bg-muted-foreground/50" />
            {m.relay_status_connecting({ hostname: relay.hostname })}
          </span>
        )}
        {relay.state === "paused" && (
          <>
            <span className="flex items-center gap-2 text-muted-foreground">
              <StatusDot className="bg-muted-foreground/50" />
              {m.relay_status_paused()}
            </span>
            <span className="font-mono text-muted-foreground">{relay.hostname}</span>
          </>
        )}
      </p>
      {relay.state === "connecting" && relay.error !== null && <FieldError>{relay.error}</FieldError>}
    </div>
  )
}

function PairPhone() {
  const status = useAtomValue(remoteStatusAtom)
  return AsyncResult.isSuccess(status) && status.value.listening ? <PairingSection /> : null
}

function PairingSection() {
  const pairing = useAtomValue(remotePairingAtom)
  const refresh = useAtomRefresh(remotePairingAtom)
  const headingId = useId()

  return (
    <section aria-labelledby={headingId} className={cn(settingsSurfaceClass, "flex flex-col gap-4 p-4")}>
      <h3 id={headingId} className="text-sm font-medium">
        {m.remote_pair_title()}
      </h3>
      {AsyncResult.builder(pairing)
        .onInitial(() => <p className="text-sm text-muted-foreground">{m.remote_pair_loading()}</p>)
        .onSuccess((value) => <PairingDetails pairing={value} onRotated={refresh} />)
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
  readonly onRotated: () => void
}

function PairingDetails({ pairing, onRotated }: PairingDetailsProps) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const url = pairingUrl(pairing)
  const hostsId = useId()

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
      <div className="flex flex-col gap-1.5">
        <p id={hostsId} className="text-sm font-medium">
          {m.remote_pair_host_label()}
        </p>
        <ul aria-labelledby={hostsId} className="flex flex-col gap-0.5 font-mono text-sm">
          {pairing.hosts.map((host) => (
            <li key={host}>{host}</li>
          ))}
        </ul>
        {pairing.hosts.length > 1 && <FieldDescription>{m.remote_pair_host_hint()}</FieldDescription>}
      </div>
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

const qrCodeAtom = Atom.family((url: string) =>
  Atom.make(Effect.promise(() => QRCode.toString(url, { type: "svg", margin: 1 }))),
)

function PairingQrCode({ url }: { url: string }) {
  const svg = AsyncResult.getOrElse(useAtomValue(qrCodeAtom(url)), () => null)

  return (
    <div className="size-48 rounded-md bg-white p-2">
      {svg && (
        <img
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
          alt={m.remote_pair_qr_label()}
          className="size-full"
        />
      )}
    </div>
  )
}
