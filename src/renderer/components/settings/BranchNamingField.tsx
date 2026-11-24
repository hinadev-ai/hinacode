import { useAtomSet } from "@effect/atom-react"
import { useState, useTransition } from "react"
import { errorMessage } from "../../lib/errorMessage.ts"
import { updateSettingsAtom } from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { useSettingsEnvironment } from "../../lib/environments.ts"
import { m } from "../../paraglide/messages.js"
import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx"
import { Textarea } from "../ui/textarea.tsx"

export function BranchNamingField() {
  const environment = useSettingsEnvironment()
  const { branchNamingInstructions } = useSettings(environment)
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
  const [error, setError] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const save = (next: string) => {
    if (next === branchNamingInstructions) return
    startTransition(async () => {
      try {
        await updateSettings({ branchNamingInstructions: next })
        setError(null)
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })
  }

  return (
    <Field>
      <FieldLabel htmlFor="settings-branch-naming">{m.settings_branch_naming()}</FieldLabel>
      <Textarea
        id="settings-branch-naming"
        rows={3}
        defaultValue={branchNamingInstructions}
        placeholder={m.settings_branch_naming_placeholder()}
        aria-invalid={error !== null || undefined}
        onBlur={(event) => save(event.target.value)}
      />
      <FieldDescription>{m.settings_branch_naming_hint()}</FieldDescription>
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}
