import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useState } from "react"
import { Locale, type UpdateState } from "../../../shared/domain.ts"
import { callPromise, updateClientSettingsAtom, updateStatusAtom } from "../../lib/rpc.ts"
import { m } from "../../paraglide/messages.js"
import { useLocale } from "../../stores/locale.ts"
import { Button } from "../ui/button.tsx"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "../ui/field.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx"
import { SettingsSection } from "./SettingsSection.tsx"
import { errorMessage } from "../../lib/errorMessage.ts"

const localeLabel = { en: m.locale_en, "zh-TW": m.locale_zh_tw, ja: m.locale_ja } satisfies Record<Locale, () => string>
const isLocale = (value: unknown): value is Locale => Locale.literals.some((locale) => locale === value)

export function GeneralSettings() {
  const locale = useLocale((state) => state.locale)
  const applyLocale = useLocale((state) => state.apply)
  const updateClientSettings = useAtomSet(updateClientSettingsAtom, { mode: "promise" })
  const [error, setError] = useState<string | null>(null)
  const locales = Locale.literals.map((value) => ({ value, label: localeLabel[value]() }))

  const changeLocale = async (next: unknown) => {
    if (!isLocale(next) || next === locale) return
    try {
      const saved = await updateClientSettings({ locale: next })
      applyLocale(saved.locale)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <SettingsSection title={m.settings_general()}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="settings-locale">{m.settings_language()}</FieldLabel>
          {/* The wrapper takes Field's full-width child rule so the trigger can stay narrow. */}
          <div>
            <Select items={locales} value={locale} onValueChange={changeLocale}>
              <SelectTrigger id="settings-locale" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {locales.map((item) => (
                  <SelectItem key={item.value} value={item.value} lang={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <FieldDescription>{m.settings_language_hint()}</FieldDescription>
          {error && <FieldError>{error}</FieldError>}
        </Field>
        <VersionField />
      </FieldGroup>
    </SettingsSection>
  )
}

const updateStateText = (state: UpdateState) => {
  switch (state.type) {
    case "unsupported":
      return m.update_unsupported()
    case "idle":
      return ""
    case "checking":
      return m.update_checking()
    case "upToDate":
      return m.update_up_to_date()
    case "downloading":
      return m.update_downloading({ version: state.version })
    case "ready":
      return m.update_ready_tooltip({ version: state.version })
    case "failed":
      return m.update_failed({ message: state.message })
  }
}

function VersionField() {
  const status = AsyncResult.getOrElse(useAtomValue(updateStatusAtom(null)), () => null)
  if (status === null) return null
  const { current, state } = status
  const busy = state.type === "unsupported" || state.type === "checking" || state.type === "downloading"
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldTitle>{m.settings_version()}</FieldTitle>
        <FieldDescription className="tabular-nums">{current}</FieldDescription>
        {state.type === "failed" ? (
          <FieldError>{updateStateText(state)}</FieldError>
        ) : (
          <output className="text-sm text-muted-foreground">{updateStateText(state)}</output>
        )}
      </FieldContent>
      {state.type === "ready" ? (
        <Button size="sm" onClick={() => void callPromise("updates.install", undefined)}>
          {m.update_restart()}
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void callPromise("updates.check", undefined)}
        >
          {m.update_check()}
        </Button>
      )}
    </Field>
  )
}
