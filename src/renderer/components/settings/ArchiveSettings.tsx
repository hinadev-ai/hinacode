import { useAtomSet } from "@effect/atom-react"
import { type FormEvent, useState } from "react"
import { type ArchiveSettings as Archive, DAYS_RANGE } from "../../../shared/domain.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { updateSettingsAtom } from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { useSettingsEnvironment } from "../../lib/environments.ts"
import { m } from "../../paraglide/messages.js"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx"
import { Input } from "../ui/input.tsx"
import { Switch } from "../ui/switch.tsx"
import { SettingsGroup, SettingsSection } from "./SettingsSection.tsx"

type SwitchKey = "whenMerged" | "removeWorktree"
type DaysKey = "settleAfterIdleDays" | "archiveAfterSettledDays"

interface Row<K> {
  readonly key: K
  readonly label: () => string
  readonly hint: () => string
}

const rows: ReadonlyArray<({ readonly kind: "switch" } & Row<SwitchKey>) | ({ readonly kind: "days" } & Row<DaysKey>)> =
  [
    {
      kind: "switch",
      key: "whenMerged",
      label: m.settings_archive_when_merged,
      hint: m.settings_archive_when_merged_hint,
    },
    {
      kind: "days",
      key: "settleAfterIdleDays",
      label: m.settings_archive_settle_idle,
      hint: m.settings_archive_settle_idle_hint,
    },
    {
      kind: "days",
      key: "archiveAfterSettledDays",
      label: m.settings_archive_after_settled,
      hint: m.settings_archive_after_settled_hint,
    },
    {
      kind: "switch",
      key: "removeWorktree",
      label: m.settings_archive_remove_worktree,
      hint: m.settings_archive_remove_worktree_hint,
    },
  ]

const parseDays = (draft: string): number | null | undefined => {
  if (draft.trim() === "") return null
  const days = Number(draft)
  return Number.isInteger(days) && days >= DAYS_RANGE.minimum && days <= DAYS_RANGE.maximum ? days : undefined
}

export function ArchiveSettings() {
  const environment = useSettingsEnvironment()
  const { archive } = useSettings(environment)
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
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
      <SettingsGroup>
        {rows.map((row) => {
          const id = `settings-archive-${row.key}`
          return (
            <Field key={row.key} orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor={id}>{row.label()}</FieldLabel>
                <FieldDescription>{row.hint()}</FieldDescription>
              </FieldContent>
              {row.kind === "switch" ? (
                <Switch
                  id={id}
                  checked={archive[row.key]}
                  onCheckedChange={(checked) => void save({ [row.key]: checked })}
                />
              ) : (
                <DaysInput
                  key={archive[row.key]}
                  id={id}
                  days={archive[row.key]}
                  onCommit={(days) => void save({ [row.key]: days })}
                />
              )}
            </Field>
          )
        })}
      </SettingsGroup>
      {error && <FieldError>{error}</FieldError>}
    </SettingsSection>
  )
}

function DaysInput({
  id,
  days,
  onCommit,
}: {
  id: string
  days: number | null
  onCommit: (days: number | null) => void
}) {
  const [draft, setDraft] = useState(days === null ? "" : String(days))

  const commit = () => {
    const next = parseDays(draft)
    if (next === undefined) setDraft(days === null ? "" : String(days))
    else if (next !== days) onCommit(next)
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    commit()
  }

  return (
    <form onSubmit={onSubmit} className="flex shrink-0 items-center gap-2">
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={DAYS_RANGE.minimum}
        max={DAYS_RANGE.maximum}
        step={1}
        value={draft}
        placeholder={m.settings_archive_never()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        className="w-20 tabular-nums"
      />
      <span className="text-sm text-muted-foreground">{m.settings_archive_days_unit()}</span>
    </form>
  )
}
