import { useAtomSet } from "@effect/atom-react"
import { useState } from "react"
import type { ArchiveSettings as Archive } from "../../../shared/domain.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { updateSettingsAtom } from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { m } from "../../paraglide/messages.js"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "../ui/field.tsx"
import { Switch } from "../ui/switch.tsx"
import { SettingsSection } from "./SettingsSection.tsx"

const toggles: ReadonlyArray<{
  readonly key: keyof Archive
  readonly label: () => string
  readonly hint: () => string
}> = [
  { key: "whenMerged", label: m.settings_archive_when_merged, hint: m.settings_archive_when_merged_hint },
  { key: "removeWorktree", label: m.settings_archive_remove_worktree, hint: m.settings_archive_remove_worktree_hint },
]

export function ArchiveSettings() {
  const { archive } = useSettings()
  const updateSettings = useAtomSet(updateSettingsAtom, { mode: "promise" })
  const [error, setError] = useState<string | null>(null)

  const save = async (patch: Partial<Archive>) => {
    setError(null)
    try {
      await updateSettings({ archive: { ...archive, ...patch } })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <SettingsSection title={m.settings_archive()} description={m.settings_archive_hint()}>
      <FieldGroup>
        {toggles.map(({ key, label, hint }) => (
          <Field key={key} orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={`settings-archive-${key}`}>{label()}</FieldLabel>
              <FieldDescription>{hint()}</FieldDescription>
            </FieldContent>
            <Switch
              id={`settings-archive-${key}`}
              checked={archive[key]}
              onCheckedChange={(checked) => void save({ [key]: checked })}
            />
          </Field>
        ))}
        {error && <FieldError>{error}</FieldError>}
      </FieldGroup>
    </SettingsSection>
  )
}
