import { useAtomSet } from "@effect/atom-react"
import { type FormEvent, useState, useTransition } from "react"
import { errorMessage } from "../../lib/errorMessage.ts"
import { updateSettingsAtom } from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { useSettingsEnvironment } from "../../lib/environments.ts"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"
import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx"
import { Input } from "../ui/input.tsx"
import { SettingsGroup, SettingsSection } from "./SettingsSection.tsx"

export function WorkspaceSettings() {
  return (
    <SettingsSection title={m.settings_workspace()}>
      <SettingsGroup>
        <WorktreeRootField />
      </SettingsGroup>
    </SettingsSection>
  )
}

function WorktreeRootField() {
  const environment = useSettingsEnvironment()
  const { worktreeRoot } = useSettings(environment)
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
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
