import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import {
  type FormEvent,
  type KeyboardEvent,
  startTransition,
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from "react"
import type { Environment, RelayAccountStatus } from "../../../shared/domain.ts"
import type { PendingLink, RelayHost } from "../../../shared/relayMachines.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { type Cloud, cloudAddress, incompatibleText, useClouds } from "../../lib/environments.ts"
import { formatRelativeTime } from "../../lib/relativeTime.ts"
import {
  addEnvironmentAtom,
  approveRelayLinkAtom,
  callPromise,
  cloudUpdatesAtom,
  installUpdatesAtom,
  pendingRelayLinkAtom,
  relayAccountAtom,
  relayMachinesAtom,
  removeEnvironmentAtom,
  removeRelayMachineAtom,
  setRelayMachineShownAtom,
  signInRelayAtom,
  signOutRelayAtom,
  syncRelayAtom,
  updateStatusAtom,
} from "../../lib/rpc.ts"
import { useNow } from "../../lib/useNow.ts"
import { m } from "../../paraglide/messages.js"
import { useLocale } from "../../stores/locale.ts"
import { useUi } from "../../stores/ui.ts"
import { EnvironmentStatusText } from "../EnvironmentStatusText.tsx"
import { ReconnectButton } from "../ReconnectButton.tsx"
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "../ui/field.tsx"
import { Input } from "../ui/input.tsx"
import { Switch } from "../ui/switch.tsx"
import { SettingsSection, settingsGroupClass, settingsSurfaceClass } from "./SettingsSection.tsx"

export function EnvironmentSettings() {
  const clouds = useClouds()

  return (
    <SettingsSection
      title={m.settings_environments()}
      description={m.environments_description()}
      action={<UpdateAllButton />}
    >
      <RelayAccountSection />
      {clouds.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.environments_empty()}</p>
      ) : (
        <ul aria-label={m.settings_environments()} className={settingsGroupClass}>
          {clouds.map((cloud) => (
            <EnvironmentRow key={cloud.id} cloud={cloud} />
          ))}
        </ul>
      )}
      <AddEnvironmentForm />
    </SettingsSection>
  )
}

function RelayAccountSection() {
  const status = AsyncResult.getOrElse(useAtomValue(relayAccountAtom), () => null)
  if (status === null) return null
  return status.state === "signedIn" ? <RelaySignedIn status={status} /> : <RelaySignInForm />
}

function RelaySignInForm() {
  const signIn = useAtomSet(signInRelayAtom, { mode: "promise" })
  const [ownerToken, setOwnerToken] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startSignIn] = useTransition()

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    startSignIn(async () => {
      setError(null)
      try {
        await signIn(ownerToken.trim())
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-labelledby="environment-relay-title"
      className={cn(settingsSurfaceClass, "flex flex-col gap-4 p-4")}
    >
      <h3 id="environment-relay-title" className="text-sm font-medium">
        {m.environment_relay_title()}
      </h3>
      <Field>
        <FieldLabel htmlFor="environment-relay-owner-token">{m.environment_relay_owner_token_label()}</FieldLabel>
        <div className="flex flex-wrap gap-2">
          <Input
            id="environment-relay-owner-token"
            type="password"
            required
            value={ownerToken}
            onChange={(event) => setOwnerToken(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error !== null}
            className="min-w-48 flex-1 font-mono"
          />
          <Button type="submit" className="shrink-0" disabled={pending || ownerToken.trim() === ""}>
            {pending ? m.environment_relay_signing_in() : m.environment_relay_sign_in()}
          </Button>
        </div>
        <FieldDescription>{m.environment_relay_description()}</FieldDescription>
        {error && <FieldError>{error}</FieldError>}
      </Field>
    </form>
  )
}

function RelaySignedIn({ status }: { status: Extract<RelayAccountStatus, { state: "signedIn" }> }) {
  const now = useNow()
  const locale = useLocale((state) => state.locale)
  const sync = useAtomSet(syncRelayAtom, { mode: "promise" })
  const [syncing, startSync] = useTransition()

  return (
    <section
      aria-labelledby="environment-relay-title"
      className={cn(settingsSurfaceClass, "flex flex-col gap-1 px-4 py-3")}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-48 flex-1 flex-col gap-0.5">
          <h3 id="environment-relay-title" className="text-sm font-medium">
            {m.environment_relay_title()}
          </h3>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className="min-w-0 truncate font-mono">
              {URL.parse(status.serviceUrl)?.host ?? status.serviceUrl}
            </span>
            <span className="whitespace-nowrap">{m.environment_relay_machines({ count: status.machines })}</span>
            {status.syncedAt !== null && (
              <span className="whitespace-nowrap">
                {m.environment_relay_synced({ time: formatRelativeTime(status.syncedAt, now, locale) })}
              </span>
            )}
          </span>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={syncing}
            onClick={() =>
              startSync(async () => {
                await sync()
              })
            }
          >
            {syncing ? m.environment_relay_syncing() : m.environment_relay_sync_now()}
          </Button>
          <RelaySignOutButton />
        </div>
      </div>
      {status.error !== null && <FieldError>{status.error}</FieldError>}
      <RelayMachines selfId={status.environmentId} />
      <ApproveRelayLinkForm />
    </section>
  )
}

function RelayMachines({ selfId }: { selfId: string }) {
  const result = useAtomValue(relayMachinesAtom)
  const refresh = useAtomRefresh(relayMachinesAtom)
  const hosts = AsyncResult.getOrElse(result, (): ReadonlyArray<RelayHost> => [])

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h4 id="environment-relay-machines-title" className="text-xs font-medium text-muted-foreground">
          {m.environment_relay_your_machines()}
        </h4>
        <Button variant="ghost" size="sm" disabled={result.waiting} onClick={refresh}>
          {m.environment_relay_refresh()}
        </Button>
      </div>
      {AsyncResult.isFailure(result) && <FieldError>{errorMessage(Cause.squash(result.cause))}</FieldError>}
      {AsyncResult.isSuccess(result) && hosts.length === 0 && (
        <p className="text-sm text-muted-foreground">{m.environment_relay_no_machines()}</p>
      )}
      {hosts.length > 0 && (
        <ul aria-labelledby="environment-relay-machines-title" className="flex flex-col divide-y divide-foreground/8">
          {hosts.map((host) => (
            <RelayMachineRow key={host.id} host={host} self={host.environmentId === selfId} />
          ))}
        </ul>
      )}
    </div>
  )
}

function RelayMachineRow({ host, self }: { host: RelayHost; self: boolean }) {
  const setShown = useAtomSet(setRelayMachineShownAtom, { mode: "promise" })
  const [error, setError] = useState<string | null>(null)
  const [pending, startToggle] = useTransition()
  const switchId = useId()

  const toggle = (enabled: boolean) =>
    startToggle(async () => {
      setError(null)
      try {
        await setShown({ id: host.id, enabled })
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })

  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-48 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{host.name}</span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className="min-w-0 truncate font-mono">{host.hostname}</span>
            {self && <span className="whitespace-nowrap">{m.environment_relay_this_machine()}</span>}
          </span>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch id={switchId} checked={host.enabled} disabled={pending} onCheckedChange={toggle} />
            <label htmlFor={switchId} className="text-xs whitespace-nowrap">
              {m.environment_relay_show()}
            </label>
          </div>
          {!self && <RemoveRelayMachineButton host={host} />}
        </div>
      </div>
      {!host.published && <FieldDescription>{m.environment_relay_not_published()}</FieldDescription>}
      {self && <FieldDescription>{m.environment_relay_this_machine_hint()}</FieldDescription>}
      {error && <FieldError>{error}</FieldError>}
    </li>
  )
}

function RemoveRelayMachineButton({ host }: { host: RelayHost }) {
  const removeMachine = useAtomSet(removeRelayMachineAtom, { mode: "promise" })
  const [open, setOpen] = useState(false)
  const [error, run, isPending] = useActionState<string | null>(async () => {
    try {
      await removeMachine(host.id)
    } catch (cause) {
      return errorMessage(cause)
    }
    setOpen(false)
    return null
  }, null)

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {m.environment_relay_remove()}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.environment_relay_remove_title({ name: host.name })}</AlertDialogTitle>
            <AlertDialogDescription>{m.environment_relay_remove_body()}</AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={isPending} onClick={() => startTransition(run)}>
              {m.environment_relay_remove()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** Approves a link code another machine printed: the code, then the machine's name to confirm, then Approve. */
function ApproveRelayLinkForm() {
  const findLink = useAtomSet(pendingRelayLinkAtom, { mode: "promise" })
  const approveLink = useAtomSet(approveRelayLinkAtom, { mode: "promise" })
  const [userCode, setUserCode] = useState("")
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null)
  const [approved, setApproved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, startBusy] = useTransition()
  const inputId = useId()

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    startBusy(async () => {
      setError(null)
      setApproved(null)
      try {
        if (pendingLink === null) {
          setPendingLink(await findLink(userCode.trim()))
          return
        }
        await approveLink(userCode.trim())
        setApproved(pendingLink.name)
        setPendingLink(null)
        setUserCode("")
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })
  }

  const cancel = () => {
    setPendingLink(null)
    setError(null)
  }

  return (
    <form onSubmit={onSubmit} className="mt-3">
      <Field>
        <FieldLabel htmlFor={inputId}>{m.environment_relay_link_code_label()}</FieldLabel>
        <div className="flex flex-wrap gap-2">
          <Input
            id={inputId}
            required
            value={userCode}
            onChange={(event) => {
              setUserCode(event.target.value)
              setPendingLink(null)
            }}
            placeholder="ABCD-EFGH"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error !== null}
            className="min-w-48 flex-1 font-mono uppercase"
          />
          {pendingLink === null && (
            <Button type="submit" variant="outline" className="shrink-0" disabled={busy || userCode.trim() === ""}>
              {busy ? m.environment_relay_link_checking() : m.environment_relay_link_continue()}
            </Button>
          )}
        </div>
        {pendingLink === null && <FieldDescription>{m.environment_relay_link_code_hint()}</FieldDescription>}
        {pendingLink !== null && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="min-w-48 flex-1 text-sm">{m.environment_relay_link_confirm({ name: pendingLink.name })}</p>
            <div className="flex shrink-0 gap-2">
              <Button type="submit" disabled={busy}>
                {busy ? m.environment_relay_approving() : m.environment_relay_approve()}
              </Button>
              <Button type="button" variant="ghost" onClick={cancel}>
                {m.common_cancel()}
              </Button>
            </div>
          </div>
        )}
        {approved !== null && (
          <output className="text-sm text-muted-foreground">
            {m.environment_relay_link_approved({ name: approved })}
          </output>
        )}
        {error && <FieldError>{error}</FieldError>}
      </Field>
    </form>
  )
}

function RelaySignOutButton() {
  const signOut = useAtomSet(signOutRelayAtom, { mode: "promise" })
  const [open, setOpen] = useState(false)
  const [error, run, isPending] = useActionState<string | null>(async () => {
    try {
      await signOut()
    } catch (cause) {
      return errorMessage(cause)
    }
    setOpen(false)
    return null
  }, null)

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {m.environment_relay_sign_out()}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.environment_relay_sign_out_title()}</AlertDialogTitle>
            <AlertDialogDescription>{m.environment_relay_sign_out_body()}</AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={isPending} onClick={() => startTransition(run)}>
              {m.environment_relay_sign_out()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function EnvironmentRow({ cloud }: { cloud: Cloud }) {
  const now = useNow()
  const locale = useLocale((state) => state.locale)
  const [pairing, setPairing] = useState(false)
  const pairAgainRef = useRef<HTMLButtonElement>(null)
  const pairFormId = useId()
  const unauthorized = cloud.status === "unauthorized"
  const fromRelay = cloud.source === "relay"

  const cancelPairing = () => {
    setPairing(false)
    pairAgainRef.current?.focus()
  }

  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-48 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{cloud.name}</span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {cloud.relay !== null && <span className="min-w-0 truncate font-mono">{cloud.relay}</span>}
            <span className="min-w-0 truncate font-mono">{cloudAddress(cloud)}</span>
            {fromRelay && <span className="whitespace-nowrap">{m.environment_relay_source()}</span>}
            <EnvironmentStatusText status={cloud.status} />
            {cloud.status === "connected" && <CloudVersion cloud={cloud} />}
            {cloud.status !== "connected" && !unauthorized && cloud.lastSeenAt !== null && (
              <span className="whitespace-nowrap tabular-nums">
                {m.environment_last_seen({ time: formatRelativeTime(cloud.lastSeenAt, now, locale) })}
              </span>
            )}
          </span>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-2">
          {cloud.status === "connected" && <CloudUpdateButton cloud={cloud} />}
          {unauthorized && (
            <Button
              ref={pairAgainRef}
              variant="outline"
              size="sm"
              aria-expanded={pairing}
              aria-controls={pairing ? pairFormId : undefined}
              onClick={() => (pairing ? cancelPairing() : setPairing(true))}
            >
              {m.environment_pair_again()}
            </Button>
          )}
          {(cloud.status === "offline" || cloud.status === "incompatible") && <ReconnectButton cloud={cloud} />}
          {!fromRelay && <RemoveEnvironmentButton cloud={cloud} />}
        </div>
      </div>
      {fromRelay && <FieldDescription>{m.environment_relay_row_hint()}</FieldDescription>}
      {unauthorized && <FieldDescription>{m.environment_unauthorized_hint()}</FieldDescription>}
      {cloud.status === "connected" && <CloudUpdateHint cloud={cloud} />}
      {unauthorized && pairing && (
        <PairAgainForm id={pairFormId} cloud={cloud} onCancel={cancelPairing} onPaired={() => setPairing(false)} />
      )}
      {cloud.status === "incompatible" && <FieldDescription>{incompatibleText(cloud)}</FieldDescription>}
    </li>
  )
}

interface PairAgainFormProps {
  readonly id: string
  readonly cloud: Cloud
  readonly onCancel: () => void
  readonly onPaired: () => void
}

/** Pairing a URL for a cloud that is already listed updates that cloud, so this keeps its name and its projects. */
function PairAgainForm({ id, cloud, onCancel, onPaired }: PairAgainFormProps) {
  const addEnvironment = useAtomSet(addEnvironmentAtom, { mode: "promise" })
  const [pairingUrl, setPairingUrl] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startPair] = useTransition()
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    startPair(async () => {
      setError(null)
      try {
        await addEnvironment({ name: cloud.name, pairingUrl: pairingUrl.trim() })
        onPaired()
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return
    // Keeps the settings page from treating this Escape as leaving the page.
    event.preventDefault()
    onCancel()
  }

  return (
    <form id={id} onSubmit={onSubmit} className="mt-2">
      <Field>
        <FieldLabel htmlFor={inputId}>{m.environment_new_pairing_url_label()}</FieldLabel>
        <div className="flex flex-wrap gap-2">
          <Input
            ref={inputRef}
            id={inputId}
            required
            value={pairingUrl}
            onChange={(event) => setPairingUrl(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="hinacode://connect?…"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error !== null}
            className="min-w-48 flex-1 font-mono"
          />
          <div className="flex shrink-0 gap-2">
            <Button type="submit" disabled={pending || pairingUrl.trim() === ""}>
              {pending ? m.environment_adding() : m.environment_pair_submit()}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel}>
              {m.common_cancel()}
            </Button>
          </div>
        </div>
        {error && <FieldError>{error}</FieldError>}
      </Field>
    </form>
  )
}

function UpdateAllButton() {
  const ready = AsyncResult.getOrElse(useAtomValue(cloudUpdatesAtom), (): ReadonlyArray<string> => [])
  const installUpdates = useAtomSet(installUpdatesAtom)
  if (ready.length === 0) return null
  return (
    <Button size="sm" onClick={() => installUpdates(ready)}>
      {m.environment_update_all()}
    </Button>
  )
}

function useCloudUpdate(cloud: Cloud) {
  return AsyncResult.getOrElse(useAtomValue(updateStatusAtom(cloud.id)), () => null)
}

function CloudVersion({ cloud }: { cloud: Cloud }) {
  const status = useCloudUpdate(cloud)
  // A cloud checks npm every few hours on its own; opening this page asks for a release published since.
  useEffect(() => {
    void callPromise("updates.check", undefined, { environment: cloud.id })
  }, [cloud.id])
  if (status === null) return null
  return <span className="tabular-nums">{m.environment_version({ version: status.current })}</span>
}

function CloudUpdateButton({ cloud }: { cloud: Cloud }) {
  const state = useCloudUpdate(cloud)?.state
  const installUpdates = useAtomSet(installUpdatesAtom)
  switch (state?.type) {
    case "ready":
      return (
        <Button variant="outline" size="sm" onClick={() => installUpdates([cloud.id])}>
          {m.environment_update_to({ version: state.version })}
        </Button>
      )
    case "downloading":
      return (
        <Button variant="outline" size="sm" disabled>
          {m.environment_updating_to({ version: state.version })}
        </Button>
      )
    case "failed":
      return (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void callPromise("updates.check", undefined, { environment: cloud.id })}
        >
          {m.update_check()}
        </Button>
      )
    default:
      return null
  }
}

function CloudUpdateHint({ cloud }: { cloud: Cloud }) {
  const state = useCloudUpdate(cloud)?.state
  if (state?.type === "ready") {
    return (
      <FieldDescription>{m.environment_update_hint({ name: cloud.name, version: state.version })}</FieldDescription>
    )
  }
  if (state?.type === "failed") return <FieldError>{state.message}</FieldError>
  return null
}

function RemoveEnvironmentButton({ cloud }: { cloud: Cloud }) {
  const removeEnvironment = useAtomSet(removeEnvironmentAtom, { mode: "promise" })
  const [open, setOpen] = useState(false)
  const [error, remove, isPending] = useActionState<string | null>(async () => {
    try {
      await removeEnvironment(cloud.id)
    } catch (cause) {
      return errorMessage(cause)
    }
    setOpen(false)
    return null
  }, null)

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {m.environment_remove()}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.environment_remove_title({ name: cloud.name })}</AlertDialogTitle>
            <AlertDialogDescription>{m.environment_remove_body()}</AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={isPending} onClick={() => startTransition(remove)}>
              {m.environment_remove()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function AddEnvironmentForm() {
  const addEnvironment = useAtomSet(addEnvironmentAtom, { mode: "promise" })
  const setAddProjectOpen = useUi((state) => state.setAddProjectOpen)
  const [name, setName] = useState("")
  const [pairingUrl, setPairingUrl] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<Environment | null>(null)
  const [pending, startAdd] = useTransition()

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    startAdd(async () => {
      setError(null)
      setAdded(null)
      try {
        setAdded(await addEnvironment({ name: name.trim(), pairingUrl: pairingUrl.trim() }))
        setName("")
        setPairingUrl("")
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-labelledby="environment-add-title"
      className={cn(settingsSurfaceClass, "flex flex-col gap-4 p-4")}
    >
      <h3 id="environment-add-title" className="text-sm font-medium">
        {m.environment_add_title()}
      </h3>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="environment-name">{m.environment_name_label()}</FieldLabel>
          <Input
            id="environment-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="home-server"
            spellCheck={false}
            autoComplete="off"
            className="w-64"
          />
          <FieldDescription>{m.environment_name_hint()}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="environment-pairing-url">{m.environment_pairing_url_label()}</FieldLabel>
          <Input
            id="environment-pairing-url"
            required
            value={pairingUrl}
            onChange={(event) => setPairingUrl(event.target.value)}
            placeholder="hinacode://connect?…"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error !== null}
            className="font-mono"
          />
          <FieldDescription>{m.environment_pairing_url_hint()}</FieldDescription>
          {error && <FieldError>{error}</FieldError>}
        </Field>
      </FieldGroup>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="submit" disabled={pending || pairingUrl.trim() === ""}>
          {pending ? m.environment_adding() : m.environment_add_submit()}
        </Button>
        <output className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          {added && (
            <>
              <span>{m.environment_added({ name: added.name })}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => setAddProjectOpen(true, added.id)}>
                {m.environment_add_project_on({ name: added.name })}
              </Button>
            </>
          )}
        </output>
      </div>
    </form>
  )
}
