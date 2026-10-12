import { useAtomSet } from "@effect/atom-react"
import { useState } from "react"
import type { Settings } from "../../../shared/domain.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { notify } from "../../lib/notify.ts"
import { updateSettingsAtom } from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "../ui/field.tsx"
import { Switch } from "../ui/switch.tsx"
import { SettingsSection } from "./SettingsSection.tsx"

type Notifications = Settings["notifications"]

const toggles: ReadonlyArray<{
  readonly key: keyof Notifications
  readonly label: () => string
  readonly hint: () => string
}> = [
  {
    key: "completed",
    label: m.settings_notifications_completed,
    hint: m.settings_notifications_completed_hint,
  },
  {
    key: "needsInput",
    label: m.settings_notifications_needs_input,
    hint: m.settings_notifications_needs_input_hint,
  },
  { key: "failed", label: m.settings_notifications_failed, hint: m.settings_notifications_failed_hint },
]

export function NotificationSettings() {
  const { notifications } = useSettings()
  const updateSettings = useAtomSet(updateSettingsAtom, { mode: "promise" })
  const [error, setError] = useState<string | null>(null)

  const save = async (patch: Partial<Notifications>) => {
    setError(null)
    try {
      await updateSettings({ notifications: { ...notifications, ...patch } })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const sendTest = () =>
    notify({ alert: "completed", title: "kkcode", body: m.notification_test(), sound: notifications.sound })

  return (
    <SettingsSection
      title={m.settings_notifications()}
      description={m.settings_notifications_hint()}
      action={
        <Button variant="outline" size="sm" onClick={sendTest}>
          {m.settings_notifications_test()}
        </Button>
      }
    >
      <FieldGroup>
        {toggles.map(({ key, label, hint }) => (
          <ToggleField
            key={key}
            id={`settings-notifications-${key}`}
            label={label()}
            hint={hint()}
            checked={notifications[key]}
            onChange={(checked) => void save({ [key]: checked })}
          />
        ))}
        <FieldSeparator />
        <ToggleField
          id="settings-notifications-sound"
          label={m.settings_notifications_sound()}
          hint={m.settings_notifications_sound_hint()}
          checked={notifications.sound}
          onChange={(sound) => void save({ sound })}
        />
        {error && <FieldError>{error}</FieldError>}
      </FieldGroup>
    </SettingsSection>
  )
}

interface ToggleFieldProps {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
}

function ToggleField({ id, label, hint, checked, onChange }: ToggleFieldProps) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{hint}</FieldDescription>
      </FieldContent>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </Field>
  )
}
