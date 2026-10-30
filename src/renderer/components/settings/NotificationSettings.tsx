import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useEffect, useState } from "react"
import type { ClientSettings } from "../../../shared/domain.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { notify } from "../../lib/notify.ts"
import { callPromise, notificationPermissionAtom, updateClientSettingsAtom } from "../../lib/rpc.ts"
import { useClientSettings } from "../../lib/settings.ts"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx"
import { Switch } from "../ui/switch.tsx"
import { SettingsGroup, SettingsPageAction, SettingsSection } from "./SettingsSection.tsx"

type Notifications = ClientSettings["notifications"]

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
  const { notifications } = useClientSettings()
  const updateClientSettings = useAtomSet(updateClientSettingsAtom, { mode: "promise" })
  const [error, setError] = useState<string | null>(null)

  const save = async (patch: Partial<Notifications>) => {
    setError(null)
    try {
      await updateClientSettings({ notifications: { ...notifications, ...patch } })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const sendTest = () =>
    notify("desktop", {
      alert: "completed",
      title: "HinaCode",
      body: m.notification_test(),
      sound: notifications.sound,
    })

  return (
    <SettingsSection>
      {import.meta.env.DEV && (
        <SettingsPageAction>
          <Button variant="outline" size="sm" onClick={sendTest}>
            {m.settings_notifications_test()}
          </Button>
        </SettingsPageAction>
      )}
      <PermissionNotice />
      <SettingsGroup>
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
      </SettingsGroup>
      <SettingsGroup>
        <ToggleField
          id="settings-notifications-sound"
          label={m.settings_notifications_sound()}
          hint={m.settings_notifications_sound_hint()}
          checked={notifications.sound}
          onChange={(sound) => void save({ sound })}
        />
      </SettingsGroup>
      {error && <FieldError>{error}</FieldError>}
    </SettingsSection>
  )
}

const PERMISSION_POLL_MS = 2000

function PermissionNotice() {
  const permission = AsyncResult.getOrElse(useAtomValue(notificationPermissionAtom), () => "unknown" as const)
  const refresh = useAtomRefresh(notificationPermissionAtom)
  // FIXME: macOS can refuse to ask, as for an app on an external volume, and still report "not determined"
  const [askRefused, setAskRefused] = useState(false)

  const ask = async () => {
    const outcome = await callPromise("notifications.askPermission", { title: "HinaCode", body: m.notification_test() })
    if (outcome === "refused") setAskRefused(true)
    refresh()
  }
  const blocked = permission === "denied" || permission === "notDetermined"

  // FIXME: neither the macOS prompt nor System Settings refocuses the window, so poll until it resolves
  useEffect(() => {
    if (!blocked) return
    const timer = setInterval(refresh, PERMISSION_POLL_MS)
    return () => clearInterval(timer)
  }, [blocked, refresh])

  if (permission === "denied" || (permission === "notDetermined" && askRefused)) {
    return <Notice title={m.settings_notifications_denied()} body={m.settings_notifications_denied_hint()} />
  }
  if (permission === "notDetermined") {
    return (
      <Notice
        title={m.settings_notifications_not_determined()}
        body={m.settings_notifications_not_determined_hint()}
        action={
          <Button variant="outline" size="sm" onClick={() => void ask()}>
            {m.settings_notifications_allow()}
          </Button>
        }
      />
    )
  }
  return null
}

function Notice({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex items-start gap-4 rounded-xl bg-attention/10 px-4 py-3">
      <div className="flex flex-1 flex-col gap-1">
        <p className="text-sm font-semibold text-attention">{title}</p>
        <p className="text-sm text-pretty text-muted-foreground">{body}</p>
      </div>
      {action}
    </div>
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
