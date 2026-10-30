import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import QRCode from "qrcode"
import { type FormEvent, useEffect, useId, useRef, useState, useTransition } from "react"
import type { RelayStatus, RemotePairing } from "../../../shared/domain.ts"
import { isPortInUse, pairingUrl } from "../../../shared/remote.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { callPromise, remotePairingAtom, remoteStatusAtom, updateSettingsAtom } from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { m } from "../../paraglide/messages.js"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog.tsx"
import { Button } from "../ui/button.tsx"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx"
import { Input } from "../ui/input.tsx"
import { Switch } from "../ui/switch.tsx"
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
              disabled={pending || remote.bindHost === null}
              onCheckedChange={(enabled) =>
                remote.bindHost !== null && save({ ...remote, enabled, bindHost: remote.bindHost })
              }
            />
          </Field>
          <RemoteStatusLine remote={remote} />
        </div>
        <ListenerSettings remote={remote} pending={pending} onSave={save} />
      </SettingsGroup>
      {error && <FieldError>{error}</FieldError>}
      <Relay />
      {remote.enabled && <PairPhone />}
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
        {remote.bindHost === null
          ? m.remote_bind_required_hint()
          : remote.bindHost === LOOPBACK
            ? m.remote_bind_loopback_hint()
            : m.remote_bind_address_hint({ address: remote.bindHost })}
      </FieldDescription>
      <FieldDescription>{m.remote_network_note()}</FieldDescription>
    </div>
  )
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
      {children}
    </a>
  )
}

function Relay() {
  const status = useAtomValue(remoteStatusAtom)
  const refreshStatus = useAtomRefresh(remoteStatusAtom)
  const refreshPairing = useAtomRefresh(remotePairingAtom)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [settingUp, startSetup] = useTransition()
  const cancelled = useRef(false)
  const headingId = useId()
  if (!AsyncResult.isSuccess(status)) return null
  const relay = status.value.relay

  const onChanged = () => {
    refreshStatus()
    refreshPairing()
  }

  const setUp = () =>
    startSetup(async () => {
      cancelled.current = false
      setSetupError(null)
      try {
        await callPromise("remote.setupRelay", undefined)
      } catch (cause) {
        if (!cancelled.current) setSetupError(errorMessage(cause))
      }
      onChanged()
    })

  const onCancel = () => {
    cancelled.current = true
  }

  return (
    <section aria-labelledby={headingId} className={cn(settingsSurfaceClass, "flex flex-col gap-3 p-4")}>
      <h3 id={headingId} className="text-sm font-medium">
        {m.relay_title()}
      </h3>
      {relay.state === "off" && (
        <div className="flex flex-col items-start gap-3">
          <FieldDescription>{m.relay_description()}</FieldDescription>
          <Button disabled={settingUp} onClick={setUp}>
            {settingUp ? m.relay_turning_on() : m.relay_turn_on()}
          </Button>
        </div>
      )}
      {relay.state === "linking" && (
        <RelayLinking url={relay.url} userCode={relay.userCode} onCancel={onCancel} onCancelled={onChanged} />
      )}
      {relay.state !== "off" && relay.state !== "linking" && (
        <>
          <RelayStatusLine relay={relay} />
          <RemoveRelayButton onRemoved={onChanged} />
        </>
      )}
      {setupError && <FieldError>{setupError}</FieldError>}
    </section>
  )
}

interface RelayLinkingProps {
  readonly url: string
  readonly userCode: string
  readonly onCancel: () => void
  readonly onCancelled: () => void
}

function RelayLinking({ url, userCode, onCancel, onCancelled }: RelayLinkingProps) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const cancel = () =>
    startTransition(async () => {
      onCancel()
      setError(null)
      try {
        await callPromise("remote.removeRelay", undefined)
        onCancelled()
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })

  return (
    <div aria-live="polite" className="flex flex-col items-start gap-3 text-sm">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {m.relay_linking()}
        <code className="rounded-md border border-border bg-muted/40 px-2 py-0.5 font-mono tracking-wider">
          {userCode}
        </code>
      </p>
      <ExternalLink href={url}>{m.relay_linking_reopen()}</ExternalLink>
      <Button variant="outline" disabled={pending} onClick={cancel}>
        {m.common_cancel()}
      </Button>
      {error && <FieldError>{error}</FieldError>}
    </div>
  )
}
function RelayStatusLine({ relay }: { relay: Exclude<RelayStatus, { state: "off" | "linking" }> }) {
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

function RemoveRelayButton({ onRemoved }: { onRemoved: () => void }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const remove = () =>
    startTransition(async () => {
      setError(null)
      try {
        await callPromise("remote.removeRelay", undefined)
        setOpen(false)
        onRemoved()
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })

  return (
    <div>
      <Button variant="destructive" onClick={() => setOpen(true)}>
        {m.relay_remove()}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen} onOpenChangeComplete={(isOpen) => isOpen || setError(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.relay_remove_title()}</AlertDialogTitle>
            <AlertDialogDescription>{m.relay_remove_body()}</AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={pending} onClick={remove}>
              {m.relay_remove()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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

  return (
    <div className="size-48 rounded-md bg-white p-2">
      {src && <img src={src} alt={m.remote_pair_qr_label()} className="size-full" />}
    </div>
  )
}
