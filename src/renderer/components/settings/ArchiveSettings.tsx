import { useAtomSet } from "@effect/atom-react"
import { useState } from "react"
import type { ArchiveSettings as Archive } from "../../../shared/domain.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { updateSettingsAtom } from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { useSettingsEnvironment } from "../../lib/environments.ts"
import { m } from "../../paraglide/messages.js"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx"
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

const NEVER = "never"
const DAY_CHOICES = [1, 3, 7, 14, 30]

const dayItems = (current: number | null) => {
  const days = current === null || DAY_CHOICES.includes(current) ? DAY_CHOICES : [...DAY_CHOICES, current]
  return [
    { value: NEVER, label: m.settings_archive_never() },
    ...days
      .toSorted((a, b) => a - b)
      .map((count) => ({ value: String(count), label: m.settings_archive_days({ count }) })),
  ]
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
                <DaysSelect id={id} days={archive[row.key]} onPick={(days) => void save({ [row.key]: days })} />
              )}
            </Field>
          )
        })}
      </SettingsGroup>
      {error && <FieldError>{error}</FieldError>}
    </SettingsSection>
  )
}

function DaysSelect({ id, days, onPick }: { id: string; days: number | null; onPick: (days: number | null) => void }) {
  const items = dayItems(days)
  return (
    <Select
      items={items}
      value={days === null ? NEVER : String(days)}
      onValueChange={(value) => value !== null && onPick(value === NEVER ? null : Number(value))}
    >
      <SelectTrigger id={id} className="w-32">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
