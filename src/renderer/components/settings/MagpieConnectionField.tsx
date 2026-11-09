import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, useState, useTransition } from "react"
import { MAGPIE_KEY_SECRET } from "../../../shared/providers.ts"
import { useSettingsEnvironment } from "../../lib/environments.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import {
  callPromise,
  modelsAtom,
  refreshAccountAtom,
  RpcError,
  secretStoredAtom,
  updateSettingsAtom,
} from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"
import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx"
import { Input } from "../ui/input.tsx"
import { CheckCircleFillIcon } from "@hinacode/icons"

type TestResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly text: string }

const ENDPOINT = /^https?:\/\/\S+$/

const orNull = (value: string) => (value.trim() === "" ? null : value.trim())

export function MagpieConnectionField() {
  const { magpieEndpoint } = useSettings(useSettingsEnvironment())
  return <MagpieConnectionForm key={magpieEndpoint ?? ""} saved={magpieEndpoint} />
}

function MagpieConnectionForm({ saved }: { saved: string | null }) {
  const environment = useSettingsEnvironment()
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
  const refreshAccount = useAtomSet(refreshAccountAtom, { mode: "promise" })
  const refreshModels = useAtomRefresh(modelsAtom(environment, "magpie"))
  const keyStored = useAtomValue(secretStoredAtom(environment, MAGPIE_KEY_SECRET))
  const refreshKeyStored = useAtomRefresh(secretStoredAtom(environment, MAGPIE_KEY_SECRET))
  const [endpoint, setEndpoint] = useState(saved ?? "")
  const [key, setKey] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<TestResult | null>(null)
  const [saving, startSaving] = useTransition()
  const hasKey = AsyncResult.getOrElse(keyStored, () => false)
  const invalid = orNull(endpoint) !== null && !ENDPOINT.test(endpoint.trim())

  const reconnect = async () => {
    refreshKeyStored()
    refreshModels()
    await refreshAccount({ environment, provider: "magpie", accountId: null })
  }

  const test = async () => {
    setResult(null)
    try {
      const { version, models } = await callPromise(
        "magpie.test",
        { endpoint: orNull(endpoint), key: orNull(key) },
        { environment },
      )
      setResult({
        ok: true,
        text:
          version === null
            ? m.settings_magpie_connected({ models })
            : m.settings_magpie_connected_version({ version, models }),
      })
    } catch (cause) {
      setResult({ ok: false, text: cause instanceof RpcError ? cause.message : errorMessage(cause) })
    }
  }

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    startSaving(async () => {
      setError(null)
      try {
        await callPromise("magpie.saveKey", { endpoint: orNull(endpoint), key: orNull(key) }, { environment })
        await updateSettings({ magpieEndpoint: orNull(endpoint) })
        setKey("")
        await reconnect()
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })
  }

  const clearKey = async () => {
    setError(null)
    try {
      await callPromise("secrets.clear", { name: MAGPIE_KEY_SECRET }, { environment })
      await reconnect()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <Field>
        <FieldLabel htmlFor="magpie-endpoint">{m.settings_magpie_endpoint_label()}</FieldLabel>
        <Input
          id="magpie-endpoint"
          type="url"
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          placeholder={m.settings_magpie_endpoint_placeholder()}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={invalid}
          className="min-w-0 flex-1 font-mono"
        />
        <FieldDescription>{m.settings_magpie_endpoint_hint()}</FieldDescription>
        {invalid && <FieldError>{m.settings_magpie_endpoint_invalid()}</FieldError>}
      </Field>
      <Field>
        <FieldLabel htmlFor="magpie-key">{m.settings_magpie_key_label()}</FieldLabel>
        <p aria-live="polite" className="flex items-center gap-1.5 text-sm">
          {hasKey ? (
            <>
              <CheckCircleFillIcon aria-hidden className="size-4 text-success" />
              {m.settings_linear_stored()}
            </>
          ) : (
            <span className="text-muted-foreground">{m.settings_linear_missing()}</span>
          )}
        </p>
        <div className="flex items-center gap-2">
          <Input
            id="magpie-key"
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={hasKey ? m.settings_magpie_key_replace_placeholder() : "sk-…"}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 font-mono"
          />
          {hasKey && (
            <Button type="button" variant="ghost" action={clearKey}>
              {m.settings_linear_clear()}
            </Button>
          )}
        </div>
        <FieldDescription>{m.settings_magpie_key_hint()}</FieldDescription>
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="outline" disabled={saving || invalid}>
          {m.settings_save()}
        </Button>
        <Button type="button" variant="ghost" disabled={invalid} action={test}>
          {m.settings_magpie_test()}
        </Button>
        {result && (
          <p
            aria-live="polite"
            className={result.ok ? "flex items-center gap-1.5 text-sm" : "text-sm text-destructive"}
          >
            {result.ok && <CheckCircleFillIcon aria-hidden className="size-4 text-success" />}
            {result.text}
          </p>
        )}
      </div>
      {error && <FieldError>{error}</FieldError>}
    </form>
  )
}
