import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, useState, useTransition } from "react"
import { RiCheckboxCircleFill } from "react-icons/ri"
import { callPromise, secretStoredAtom } from "../../lib/rpc.ts"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"
import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx"
import { Input } from "../ui/input.tsx"
import { SettingsSection } from "./SettingsSection.tsx"
import { errorMessage } from "../../lib/errorMessage.ts"

const LINEAR_KEY = "linear.apiKey"

export function IntegrationSettings() {
  return (
    <SettingsSection title={m.settings_integrations()}>
      <LinearKeyField />
    </SettingsSection>
  )
}

function LinearKeyField() {
  const stored = useAtomValue(secretStoredAtom(LINEAR_KEY))
  const refreshStored = useAtomRefresh(secretStoredAtom(LINEAR_KEY))
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const hasKey = AsyncResult.getOrElse(stored, () => false)

  const run = (action: () => Promise<void>) =>
    startTransition(async () => {
      setError(null)
      try {
        await action()
        refreshStored()
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    run(async () => {
      await callPromise("secrets.set", { name: LINEAR_KEY, value: draft.trim() })
      setDraft("")
    })
  }

  return (
    <Field>
      <FieldLabel htmlFor="linear-api-key">{m.settings_linear_label()}</FieldLabel>
      <p aria-live="polite" className="flex items-center gap-1.5 text-sm">
        {AsyncResult.builder(stored)
          .onInitial(() => <span className="text-muted-foreground">{m.settings_linear_checking()}</span>)
          .onSuccess((has) =>
            has ? (
              <>
                <RiCheckboxCircleFill aria-hidden className="size-4 text-emerald-500" />
                {m.settings_linear_stored()}
              </>
            ) : (
              <span className="text-muted-foreground">{m.settings_linear_missing()}</span>
            ),
          )
          .onError((cause) => <span className="text-destructive">{errorMessage(cause)}</span>)
          .orElse(() => null)}
      </p>
      <form onSubmit={onSubmit} className="flex items-center gap-2">
        <Input
          id="linear-api-key"
          type="password"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={m.settings_linear_placeholder()}
          autoComplete="off"
          spellCheck={false}
          className="w-72 font-mono"
        />
        <Button type="submit" variant="outline" disabled={pending || draft.trim() === ""}>
          {hasKey ? m.settings_linear_replace() : m.settings_save()}
        </Button>
        {hasKey && (
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => run(() => callPromise("secrets.clear", { name: LINEAR_KEY }))}
          >
            {m.settings_linear_clear()}
          </Button>
        )}
      </form>
      <FieldDescription>{m.settings_linear_hint()}</FieldDescription>
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}
