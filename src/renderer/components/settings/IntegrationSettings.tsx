import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, useState, useTransition } from "react"
import { RiCheckboxCircleFill } from "react-icons/ri"
import { callPromise, secretStoredAtom } from "../../lib/rpc.ts"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "../ui/field.tsx"
import { Input } from "../ui/input.tsx"
import { SettingsSection } from "./SettingsSection.tsx"

export function IntegrationSettings() {
  return (
    <SettingsSection title={m.settings_integrations()}>
      <FieldGroup>
        <SecretField
          name="linear.apiKey"
          label={m.settings_linear_label()}
          placeholder={m.settings_linear_placeholder()}
          hint={m.settings_linear_hint()}
        />
        <SecretField
          name="slack.token"
          label={m.settings_slack_label()}
          placeholder="xoxp-…"
          hint={m.settings_slack_hint()}
        />
      </FieldGroup>
    </SettingsSection>
  )
}

interface SecretFieldProps {
  /** The Secrets name the main process reads. */
  readonly name: string
  readonly label: string
  readonly placeholder: string
  readonly hint: string
}

/** A write-only secret: it can be set, replaced or cleared, never read back. */
function SecretField({ name, label, placeholder, hint }: SecretFieldProps) {
  const inputId = `secret-${name.replace(/\W/g, "-")}`
  const stored = useAtomValue(secretStoredAtom(name))
  const refreshStored = useAtomRefresh(secretStoredAtom(name))
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
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    run(async () => {
      await callPromise("secrets.set", { name, value: draft.trim() })
      setDraft("")
    })
  }

  return (
    <Field>
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
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
          .onError((cause) => <span className="text-destructive">{m.common_error({ message: cause.message })}</span>)
          .orElse(() => null)}
      </p>
      <form onSubmit={onSubmit} className="flex items-center gap-2">
        <Input
          id={inputId}
          type="password"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={placeholder}
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
            onClick={() => run(() => callPromise("secrets.clear", { name }))}
          >
            {m.settings_linear_clear()}
          </Button>
        )}
      </form>
      <FieldDescription>{hint}</FieldDescription>
      {error && <FieldError>{m.common_error({ message: error })}</FieldError>}
    </Field>
  )
}
