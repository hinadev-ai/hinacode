import { cn } from "cn"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { useHotkey } from "@tanstack/react-hotkeys"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { type ComponentType, type ReactNode, useState } from "react"
import { AppearanceSettings } from "../components/settings/AppearanceSettings.tsx"
import { EnvironmentSettings } from "../components/settings/EnvironmentSettings.tsx"
import { ExperimentalSettings } from "../components/settings/ExperimentalSettings.tsx"
import { GeneralSettings } from "../components/settings/GeneralSettings.tsx"
import { IntegrationSettings } from "../components/settings/IntegrationSettings.tsx"
import { KeybindingSettings } from "../components/settings/KeybindingSettings.tsx"
import { ModelSettings } from "../components/settings/ModelSettings.tsx"
import { NotificationSettings } from "../components/settings/NotificationSettings.tsx"
import { RemoteSettings } from "../components/settings/RemoteSettings.tsx"
import { RoutineSettings } from "../components/settings/routines/RoutineSettings.tsx"
import { SettingsNav, settingsPageOf, useLeaveSettings } from "../components/settings/SettingsNav.tsx"
import {
  PageActionSlotProvider,
  SETTINGS_FILL_WIDTH,
  SettingsSection,
} from "../components/settings/SettingsSection.tsx"
import { UsageSettings } from "../components/settings/UsageSettings.tsx"
import { WorktreeSettings } from "../components/settings/WorktreeSettings.tsx"
import { Button } from "../components/ui/button.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.tsx"
import { environmentName, useClouds, useSettingsEnvironment } from "../lib/environments.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { usePanelLayout } from "../lib/panelLayout.ts"
import { type EnvironmentId, settingsAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { inBrowser } from "../lib/runtime.ts"
import { CloudIcon, LaptopIcon } from "@hinacode/icons"

function ConnectionSettings() {
  const environment = useSettingsEnvironment()
  return (
    <div className="flex flex-col gap-12">
      <EnvironmentSettings />
      {!inBrowser() && (
        <SettingsSection
          title={m.settings_remote()}
          description={m.remote_description()}
          action={<SettingsEnvironmentPicker labelId="remote-environment" />}
        >
          <LoadedSettings key={environment ?? ""} environment={environment}>
            <RemoteSettings />
          </LoadedSettings>
        </SettingsSection>
      )}
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
  routines: RoutineSettings,
  usage: UsageSettings,
  connections: ConnectionSettings,
  experimental: ExperimentalSettings,
}

export function SettingsRoute() {
  const { page: pageId } = useSearch({ from: "/settings" })
  const leave = useLeaveSettings()
  const environment = useSettingsEnvironment()
  const page = settingsPageOf(pageId)
  const Page = components[page.id]!
  const compact = usePanelLayout() === "compact"
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null)
  const pageWidth = page.fill ? SETTINGS_FILL_WIDTH : "max-w-3xl"
  const content = (
    <PageActionSlotProvider value={actionSlot}>
      {page.scope === "environment" ? (
        <LoadedSettings key={environment ?? ""} environment={environment}>
          <Page />
        </LoadedSettings>
      ) : (
        <Page />
      )}
    </PageActionSlotProvider>
  )

  useHotkey(
    "Escape",
    (event) => {
      if (!event.defaultPrevented) leave()
    },
    // FIXME: Base UI popups close on a document Escape listener, so an Escape that closed one arrives defaultPrevented
    { target: window, ignoreInputs: true, preventDefault: false, stopPropagation: false },
  )

  return (
    <div className="flex min-h-0 flex-1">
      {compact && <SettingsNav />}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 scrollbar-gutter-both overflow-hidden window-drag">
          <div className={cn("mx-auto flex w-full items-start gap-3 px-8 pt-5 pb-6", pageWidth)}>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h1 className="text-lg font-semibold">{page.label()}</h1>
              {page.description && <p className="text-sm text-pretty text-muted-foreground">{page.description()}</p>}
            </div>
            <div ref={setActionSlot} className="flex shrink-0 items-center gap-2 empty:hidden" />
            {page.scope === "environment" && <SettingsEnvironmentPicker labelId="settings-environment" />}
          </div>
        </header>
        {page.fill ? (
          <div className="flex min-h-0 flex-1 flex-col">{content}</div>
        ) : (
          <div className="min-h-0 flex-1 scrollbar-gutter-both overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl px-8 pb-12">{content}</div>
          </div>
        )}
      </div>
    </div>
  )
}

const THIS_MACHINE = ""

function SettingsEnvironmentPicker({ labelId }: { labelId: string }) {
  const navigate = useNavigate({ from: "/settings" })
  const value = useSettingsEnvironment()
  const clouds = useClouds()
  if (clouds.length === 0) return null
  const onChange = (next: EnvironmentId) =>
    void navigate({ search: (previous) => ({ ...previous, environment: next ?? undefined }), replace: true })
  const items = [
    ...(inBrowser() ? [] : [{ value: THIS_MACHINE, label: m.environment_this_machine() }]),
    ...clouds.map((cloud) => ({ value: cloud.id, label: cloud.name })),
  ]
  return (
    <div className="flex shrink-0 items-center">
      <span id={labelId} className="sr-only">
        {m.settings_editing_for()}
      </span>
      <Select
        items={items}
        value={value ?? THIS_MACHINE}
        onValueChange={(next) => typeof next === "string" && onChange(next === THIS_MACHINE ? null : next)}
      >
        <SelectTrigger aria-labelledby={labelId} size="sm" className="w-auto max-w-56 gap-2">
          {value === null ? (
            <LaptopIcon aria-hidden className="size-4 text-muted-foreground" />
          ) : (
            <CloudIcon aria-hidden className="size-4 text-muted-foreground" />
          )}
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
