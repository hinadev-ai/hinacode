import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, useState, useTransition } from "react"
import { RiCheckboxCircleFill } from "react-icons/ri"
import { callPromise, gitHubAuthAtom, secretStoredAtom } from "../../lib/rpc.ts"
import { useSettingsEnvironment } from "../../lib/environments.ts"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "../ui/field.tsx"
import { Input } from "../ui/input.tsx"
import { SettingsSection } from "./SettingsSection.tsx"
import { errorMessage } from "../../lib/errorMessage.ts"

export function IntegrationSettings() {
  return (
    <SettingsSection title={m.settings_integrations()}>
      <FieldGroup>
        <GitHubStatus />
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

/** Whether `gh` is installed and signed in. hinacode borrows its login rather than storing a token. */
function GitHubStatus() {
  const environment = useSettingsEnvironment()
  const auth = useAtomValue(gitHubAuthAtom(environment))
  const refresh = useAtomRefresh(gitHubAuthAtom(environment))

  return (
    <Field>
      <FieldLabel>{m.settings_github_label()}</FieldLabel>
      <div className="flex items-center gap-2">
        <p aria-live="polite" className="flex items-center gap-1.5 text-sm">
          {AsyncResult.builder(auth)
            .onInitial(() => <span className="text-muted-foreground">{m.settings_github_checking()}</span>)
            .onSuccess((status) => {
              switch (status.type) {
                case "signedIn":
                  return (
                    <>
                      <RiCheckboxCircleFill aria-hidden className="size-4 text-success" />
                      {m.settings_github_signed_in({ host: status.host, login: status.login })}
                    </>
                  )
                case "missing":
                  return <span className="text-muted-foreground">{m.settings_github_missing()}</span>
                case "signedOut":
                  return (
                    <span className="text-muted-foreground">
                      {m.settings_github_signed_out_before()}{" "}
                      <code className="font-mono text-[0.85em] text-foreground">gh auth login</code>{" "}
                      {m.settings_github_signed_out_after()}
                    </span>
                  )
              }
            })
            .onError((cause) => <span className="text-destructive">{errorMessage(cause)}</span>)
            .orElse(() => null)}
        </p>
        <Button variant="ghost" size="xs" onClick={refresh}>
          {m.settings_github_check_again()}
        </Button>
      </div>
      <FieldDescription>{m.settings_github_hint()}</FieldDescription>
    </Field>
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
  const environment = useSettingsEnvironment()
  const inputId = `secret-${name.replace(/\W/g, "-")}`
  const stored = useAtomValue(secretStoredAtom(environment, name))
  const refreshStored = useAtomRefresh(secretStoredAtom(environment, name))
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
      await callPromise("secrets.set", { name, value: draft.trim() }, { environment })
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
                <RiCheckboxCircleFill aria-hidden className="size-4 text-success" />
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
            onClick={() => run(() => callPromise("secrets.clear", { name }, { environment }))}
          >
            {m.settings_linear_clear()}
          </Button>
        )}
      </form>
      <FieldDescription>{hint}</FieldDescription>
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}
