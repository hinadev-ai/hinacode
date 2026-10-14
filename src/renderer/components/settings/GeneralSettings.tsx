import { useAtomSet } from "@effect/atom-react"
import { type FormEvent, useState, useTransition } from "react"
import { Locale } from "../../../shared/domain.ts"
import { updateSettingsAtom } from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { m } from "../../paraglide/messages.js"
import { useLocale } from "../../stores/locale.ts"
import { Button } from "../ui/button.tsx"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "../ui/field.tsx"
import { Input } from "../ui/input.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx"
import { SettingsSection } from "./SettingsSection.tsx"
import { errorMessage } from "../../lib/errorMessage.ts"

const localeLabel = { en: m.locale_en, "zh-TW": m.locale_zh_tw } satisfies Record<Locale, () => string>
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
        <WorktreeRootField />
      </FieldGroup>
    </SettingsSection>
  )
}

function WorktreeRootField() {
  const { worktreeRoot } = useSettings()
  const updateSettings = useAtomSet(updateSettingsAtom, { mode: "promise" })
  const [draft, setDraft] = useState(worktreeRoot ?? "")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const next = draft.trim()

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const invalid = next !== "" && !next.startsWith("/")
    setError(invalid ? m.settings_worktree_root_absolute() : null)
    if (invalid) return
    startTransition(async () => {
      try {
        await updateSettings({ worktreeRoot: next === "" ? null : next })
        setDraft(next)
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })
  }

  return (
    <Field>
      <FieldLabel htmlFor="settings-worktree-root">{m.settings_worktree_root()}</FieldLabel>
      <form onSubmit={onSubmit} className="flex items-center gap-2">
        <Input
          id="settings-worktree-root"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="/path/to/worktrees"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error !== null}
          className="w-72 font-mono"
        />
        <Button type="submit" variant="outline" disabled={pending || next === (worktreeRoot ?? "")}>
          {m.settings_save()}
        </Button>
      </form>
      <FieldDescription>{m.settings_worktree_root_hint()}</FieldDescription>
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}
