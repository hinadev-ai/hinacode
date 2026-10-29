import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { useHotkey } from "@tanstack/react-hotkeys"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import type { ComponentType, ReactNode } from "react"
import { AppearanceSettings } from "../components/settings/AppearanceSettings.tsx"
import { AutomationSettings } from "../components/settings/automations/AutomationSettings.tsx"
import { EnvironmentSettings } from "../components/settings/EnvironmentSettings.tsx"
import { ExperimentalSettings } from "../components/settings/ExperimentalSettings.tsx"
import { GeneralSettings } from "../components/settings/GeneralSettings.tsx"
import { IntegrationSettings } from "../components/settings/IntegrationSettings.tsx"
import { KeybindingSettings } from "../components/settings/KeybindingSettings.tsx"
import { ModelSettings } from "../components/settings/ModelSettings.tsx"
import { NotificationSettings } from "../components/settings/NotificationSettings.tsx"
import { RemoteSettings } from "../components/settings/RemoteSettings.tsx"
import { SettingsNav, settingsPageOf, useLeaveSettings } from "../components/settings/SettingsNav.tsx"
import { WorktreeSettings } from "../components/settings/WorktreeSettings.tsx"
import { Button } from "../components/ui/button.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.tsx"
import { type Cloud, environmentName, useClouds, useSettingsEnvironment } from "../lib/environments.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { usePanelLayout } from "../lib/panelLayout.ts"
import { type EnvironmentId, settingsAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"

/** Paired machines, and this machine's own remote control, which always edits local settings. */
function ConnectionSettings() {
  return (
    <div className="flex flex-col gap-12">
      <EnvironmentSettings />
      <LoadedSettings environment={null}>
        <RemoteSettings />
      </LoadedSettings>
    </div>
  )
}

const components: Record<string, ComponentType> = {
  general: GeneralSettings,
  appearance: AppearanceSettings,
  notifications: NotificationSettings,
  keybindings: KeybindingSettings,
  providers: ModelSettings,
  worktrees: WorktreeSettings,
  integrations: IntegrationSettings,
  automations: AutomationSettings,
  connections: ConnectionSettings,
  experimental: ExperimentalSettings,
}

export function SettingsRoute() {
  const { page: pageId } = useSearch({ from: "/settings" })
  const navigate = useNavigate({ from: "/settings" })
  const leave = useLeaveSettings()
  const environment = useSettingsEnvironment()
  const clouds = useClouds()
  const page = settingsPageOf(pageId)
  const Page = components[page.id]!
  // A docked nav lives in the app's sidebar column; a compact window has none, so the page brings its own.
  const compact = usePanelLayout() === "compact"

  useHotkey(
    "Escape",
    (event) => {
      if (!event.defaultPrevented) leave()
    },
    // A field keeps Escape, so a draft is never thrown away by leaving the page. Popups close on a document
    // listener, and window hears the key after it, so an Escape that closed a popup arrives defaultPrevented.
    { target: window, ignoreInputs: true, preventDefault: false, stopPropagation: false },
  )

  return (
    <div className="flex min-h-0 flex-1">
      {compact && <SettingsNav />}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="window-drag flex h-12 shrink-0 items-center gap-3 border-b border-border px-6">
          <h1 className="text-sm font-semibold">{m.settings_title()}</h1>
          {page.scope === "environment" && clouds.length > 0 && (
            <EnvironmentPicker
              labelId="settings-environment"
              value={environment}
              clouds={clouds}
              onChange={(next) =>
                void navigate({
                  search: (previous) => ({ ...previous, environment: next ?? undefined }),
                  replace: true,
                })
              }
            />
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-8 py-8">
            {page.scope === "environment" ? (
              // Keyed by environment so drafts in the page's fields never carry over to another machine.
              <LoadedSettings key={environment ?? ""} environment={environment}>
                <Page />
              </LoadedSettings>
            ) : (
              <Page />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const THIS_MACHINE = ""

interface EnvironmentPickerProps {
  readonly labelId: string
  readonly value: EnvironmentId
  readonly clouds: ReadonlyArray<Cloud>
  readonly onChange: (environment: EnvironmentId) => void
}

function EnvironmentPicker({ labelId, value, clouds, onChange }: EnvironmentPickerProps) {
  const items = [
    { value: THIS_MACHINE, label: m.environment_this_machine() },
    ...clouds.map((cloud) => ({ value: cloud.id, label: cloud.name })),
  ]
  return (
    <div className="ml-auto flex items-center gap-2">
      <span id={labelId} className="text-xs text-muted-foreground">
        {m.settings_editing_for()}
      </span>
      <Select
        items={items}
        value={value ?? THIS_MACHINE}
        onValueChange={(next) => typeof next === "string" && onChange(next === THIS_MACHINE ? null : next)}
      >
        <SelectTrigger aria-labelledby={labelId} size="sm" className="w-44">
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
    </div>
  )
}

/** Renders once the environment's settings answered, so its fields never start from defaults. */
function LoadedSettings({ environment, children }: { environment: EnvironmentId; children: ReactNode }) {
  const settings = useAtomValue(settingsAtom(environment))
  const refresh = useAtomRefresh(settingsAtom(environment))
  const name = environmentName(environment, useClouds())

  return AsyncResult.builder(settings)
    .onInitial(() => <p className="text-sm text-muted-foreground">{m.settings_environment_loading({ name })}</p>)
    .onSuccess(() => children)
    .onError((cause) => (
      <div role="alert" className="flex flex-col items-start gap-2">
        <p className="text-sm text-destructive">{errorMessage(cause)}</p>
        <Button variant="outline" size="sm" onClick={refresh}>
          {m.common_retry()}
        </Button>
      </div>
    ))
    .orElse(() => null)
}
