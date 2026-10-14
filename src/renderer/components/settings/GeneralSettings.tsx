import { useAtomSet } from "@effect/atom-react"
import { useState } from "react"
import { Locale } from "../../../shared/domain.ts"
import { updateSettingsAtom } from "../../lib/rpc.ts"
import { m } from "../../paraglide/messages.js"
import { useLocale } from "../../stores/locale.ts"
import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx"
import { SettingsSection } from "./SettingsSection.tsx"
import { errorMessage } from "../../lib/errorMessage.ts"

const localeLabel = { en: m.locale_en, "zh-TW": m.locale_zh_tw, ja: m.locale_ja } satisfies Record<Locale, () => string>
const isLocale = (value: unknown): value is Locale => Locale.literals.some((locale) => locale === value)

export function GeneralSettings() {
  const locale = useLocale((state) => state.locale)
  const applyLocale = useLocale((state) => state.apply)
  const updateSettings = useAtomSet(updateSettingsAtom, { mode: "promise" })
  const [error, setError] = useState<string | null>(null)
  const locales = Locale.literals.map((value) => ({ value, label: localeLabel[value]() }))

  const changeLocale = async (next: unknown) => {
    if (!isLocale(next) || next === locale) return
    try {
      const saved = await updateSettings({ locale: next })
      applyLocale(saved.locale)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <SettingsSection title={m.settings_general()}>
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
    </SettingsSection>
  )
}
