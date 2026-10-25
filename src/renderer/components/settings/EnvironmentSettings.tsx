import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
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
import type { Environment } from "../../../shared/domain.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { type Cloud, cloudAddress, incompatibleText, useClouds } from "../../lib/environments.ts"
import { formatRelativeTime } from "../../lib/relativeTime.ts"
import {
  addEnvironmentAtom,
  callPromise,
  cloudUpdatesAtom,
  installUpdatesAtom,
  removeEnvironmentAtom,
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
import { SettingsSection, settingsGroupClass, settingsSurfaceClass } from "./SettingsSection.tsx"

export function EnvironmentSettings() {
  const clouds = useClouds()

  return (
    <SettingsSection
      title={m.settings_environments()}
      description={m.environments_description()}
      action={<UpdateAllButton />}
    >
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

function EnvironmentRow({ cloud }: { cloud: Cloud }) {
  const now = useNow()
  const locale = useLocale((state) => state.locale)
  const [pairing, setPairing] = useState(false)
  const pairAgainRef = useRef<HTMLButtonElement>(null)
  const pairFormId = useId()
  const unauthorized = cloud.status === "unauthorized"

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
            <span className="min-w-0 truncate font-mono">{cloudAddress(cloud)}</span>
            <EnvironmentStatusText status={cloud.status} />
            {cloud.status === "connected" && <CloudVersion cloud={cloud} />}
            {cloud.status !== "connected" && !unauthorized && cloud.lastSeenAt !== null && (
              <span className="whitespace-nowrap">
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
          <RemoveEnvironmentButton cloud={cloud} />
        </div>
      </div>
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
