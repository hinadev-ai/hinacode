import { useAtomSet } from "@effect/atom-react"
import { useState } from "react"
import { Locale } from "../../shared/domain.ts"
import { Field, FieldDescription, FieldError, FieldLabel } from "../components/ui/field.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.tsx"
import { updateSettingsAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { useLocale } from "../stores/locale.ts"

const localeLabel = { en: m.locale_en, "zh-TW": m.locale_zh_tw } satisfies Record<Locale, () => string>
const isLocale = (value: unknown): value is Locale => Locale.literals.some((locale) => locale === value)

export function SettingsRoute() {
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
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="flex h-12 shrink-0 items-center border-b border-border px-6">
        <h1 className="text-sm font-semibold">{m.settings_title()}</h1>
      </header>
      <div className="flex w-full max-w-xl flex-col gap-8 px-6 py-6">
        <section className="flex flex-col gap-4">
          <h2 className="text-xs font-medium text-muted-foreground">{m.settings_general()}</h2>
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
            {error && <FieldError>{m.common_error({ message: error })}</FieldError>}
          </Field>
        </section>
        <section className="flex flex-col gap-1">
          <h2 className="text-xs font-medium text-muted-foreground">{m.settings_later_title()}</h2>
          <p className="text-sm text-muted-foreground">{m.settings_later_hint()}</p>
        </section>
      </div>
    </div>
  )
}
