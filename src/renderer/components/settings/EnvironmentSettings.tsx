import { useAtomSet } from "@effect/atom-react"
import { type FormEvent, type RefObject, startTransition, useActionState, useRef, useState, useTransition } from "react"
import { errorMessage } from "../../lib/errorMessage.ts"
import { type Cloud, cloudAddress, useClouds } from "../../lib/environments.ts"
import { formatRelativeTime } from "../../lib/relativeTime.ts"
import { addEnvironmentAtom, removeEnvironmentAtom } from "../../lib/rpc.ts"
import { useNow } from "../../lib/useNow.ts"
import { m } from "../../paraglide/messages.js"
import { useLocale } from "../../stores/locale.ts"
import { EnvironmentStatusText } from "../EnvironmentStatusText.tsx"
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
import { SettingsSection } from "./SettingsSection.tsx"

export function EnvironmentSettings() {
  const clouds = useClouds()
  const [name, setName] = useState("")
  const pairingUrlRef = useRef<HTMLInputElement>(null)

  const pairAgain = (cloud: Cloud) => {
    setName(cloud.name)
    pairingUrlRef.current?.focus()
  }

  return (
    <SettingsSection title={m.settings_environments()} description={m.environments_description()}>
      {clouds.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.environments_empty()}</p>
      ) : (
        <ul aria-label={m.settings_environments()} className="flex flex-col divide-y divide-border rounded-lg border">
          {clouds.map((cloud) => (
            <EnvironmentRow key={cloud.id} cloud={cloud} onPairAgain={() => pairAgain(cloud)} />
          ))}
        </ul>
      )}
      <AddEnvironmentForm name={name} onNameChange={setName} pairingUrlRef={pairingUrlRef} />
    </SettingsSection>
  )
}

function EnvironmentRow({ cloud, onPairAgain }: { cloud: Cloud; onPairAgain: () => void }) {
  const now = useNow()
  const locale = useLocale((state) => state.locale)

  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{cloud.name}</span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className="font-mono">{cloudAddress(cloud)}</span>
            <EnvironmentStatusText status={cloud.status} />
            {cloud.status !== "connected" && cloud.lastSeenAt !== null && (
              <span>{m.environment_last_seen({ time: formatRelativeTime(cloud.lastSeenAt, now, locale) })}</span>
            )}
          </span>
        </div>
        {cloud.status === "unauthorized" && (
          <Button variant="outline" size="sm" onClick={onPairAgain}>
            {m.environment_pair_again()}
          </Button>
        )}
        <RemoveEnvironmentButton cloud={cloud} />
      </div>
      {cloud.status === "unauthorized" && <FieldDescription>{m.environment_unauthorized_hint()}</FieldDescription>}
      {cloud.status === "incompatible" && (
        <FieldDescription>{m.environment_incompatible_hint({ name: cloud.name })}</FieldDescription>
      )}
    </li>
  )
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

interface AddEnvironmentFormProps {
  readonly name: string
  readonly onNameChange: (name: string) => void
  /** Pair again focuses it, since pasting a new URL for a listed cloud updates that cloud. */
  readonly pairingUrlRef: RefObject<HTMLInputElement | null>
}

function AddEnvironmentForm({ name, onNameChange, pairingUrlRef }: AddEnvironmentFormProps) {
  const addEnvironment = useAtomSet(addEnvironmentAtom, { mode: "promise" })
  const [pairingUrl, setPairingUrl] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startAdd] = useTransition()

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    startAdd(async () => {
      setError(null)
      try {
        await addEnvironment({ name: name.trim(), pairingUrl: pairingUrl.trim() })
        onNameChange("")
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
      className="flex flex-col gap-4 rounded-lg border border-border p-4"
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
            onChange={(event) => onNameChange(event.target.value)}
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
            ref={pairingUrlRef}
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
      <div>
        <Button type="submit" disabled={pending || pairingUrl.trim() === ""}>
          {pending ? m.environment_adding() : m.environment_add_submit()}
        </Button>
      </div>
    </form>
  )
}
