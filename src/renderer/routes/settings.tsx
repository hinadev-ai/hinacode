import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { useHotkey } from "@tanstack/react-hotkeys"
import { useNavigate, useRouter, useSearch } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import type { ComponentType } from "react"
import type { IconType } from "react-icons"
import {
  RiArchiveLine,
  RiCpuLine,
  RiFlaskLine,
  RiFlashlightLine,
  RiFolderLine,
  RiKeyboardLine,
  RiNotification3Line,
  RiPaletteLine,
  RiPlugLine,
  RiServerLine,
  RiSettings3Line,
  RiSmartphoneLine,
} from "react-icons/ri"
import { AppearanceSettings } from "../components/settings/AppearanceSettings.tsx"
import { ArchiveSettings } from "../components/settings/ArchiveSettings.tsx"
import { AutomationSettings } from "../components/settings/automations/AutomationSettings.tsx"
import { EnvironmentSettings } from "../components/settings/EnvironmentSettings.tsx"
import { ExperimentalSettings } from "../components/settings/ExperimentalSettings.tsx"
import { GeneralSettings } from "../components/settings/GeneralSettings.tsx"
import { IntegrationSettings } from "../components/settings/IntegrationSettings.tsx"
import { KeybindingSettings } from "../components/settings/KeybindingSettings.tsx"
import { ModelSettings } from "../components/settings/ModelSettings.tsx"
import { NotificationSettings } from "../components/settings/NotificationSettings.tsx"
import { RemoteSettings } from "../components/settings/RemoteSettings.tsx"
import { WorkspaceSettings } from "../components/settings/WorkspaceSettings.tsx"
import { Button } from "../components/ui/button.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.tsx"
import { type Cloud, environmentName, useClouds, useSettingsEnvironment } from "../lib/environments.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { type EnvironmentId, settingsAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"

interface SettingsPage {
  readonly id: string
  /** `app` edits this machine. `environment` edits the machine picked in the settings nav. */
  readonly scope: "app" | "environment"
  readonly label: () => string
  readonly icon: IconType
  readonly component: ComponentType
  /** A cloud refuses the page's methods, so it shows for this machine only. */
  readonly localOnly?: boolean
}

const pages: ReadonlyArray<SettingsPage> = [
  { id: "general", scope: "app", label: m.settings_general, icon: RiSettings3Line, component: GeneralSettings },
  { id: "appearance", scope: "app", label: m.settings_appearance, icon: RiPaletteLine, component: AppearanceSettings },
  {
    id: "keybindings",
    scope: "app",
    label: m.settings_keybindings,
    icon: RiKeyboardLine,
    component: KeybindingSettings,
  },
  {
    id: "notifications",
    scope: "app",
    label: m.settings_notifications,
    icon: RiNotification3Line,
    component: NotificationSettings,
  },
  {
    id: "environments",
    scope: "app",
    label: m.settings_environments,
    icon: RiServerLine,
    component: EnvironmentSettings,
  },
  { id: "models", scope: "environment", label: m.settings_models, icon: RiCpuLine, component: ModelSettings },
  { id: "archive", scope: "environment", label: m.settings_archive, icon: RiArchiveLine, component: ArchiveSettings },
  {
    id: "workspace",
    scope: "environment",
    label: m.settings_workspace,
    icon: RiFolderLine,
    component: WorkspaceSettings,
  },
  {
    id: "integrations",
    scope: "environment",
    label: m.settings_integrations,
    icon: RiPlugLine,
    component: IntegrationSettings,
  },
  {
    id: "automations",
    scope: "environment",
    label: m.settings_automations,
    icon: RiFlashlightLine,
    component: AutomationSettings,
  },
  {
    id: "remote",
    scope: "environment",
    label: m.settings_remote,
    icon: RiSmartphoneLine,
    component: RemoteSettings,
    localOnly: true,
  },
  {
    id: "experimental",
    scope: "environment",
    label: m.settings_experimental,
    icon: RiFlaskLine,
    component: ExperimentalSettings,
  },
]

export function SettingsRoute() {
  const { page: pageId } = useSearch({ from: "/settings" })
  const navigate = useNavigate({ from: "/settings" })
  const { history } = useRouter()
  const environment = useSettingsEnvironment()
  const clouds = useClouds()
  const shown = pages.filter((candidate) => !(environment !== null && candidate.localOnly))
  const requested = pages.find((candidate) => candidate.id === pageId)
  // A page hidden for the picked environment falls back to the first page of its group, not of the whole list.
  const page =
    shown.find((candidate) => candidate.id === pageId) ??
    shown.find((candidate) => candidate.scope === requested?.scope) ??
    shown[0]

  useHotkey(
    "Escape",
    (event) => {
      if (event.defaultPrevented) return
      if (history.canGoBack()) history.back()
      else void navigate({ to: "/" })
    },
    // A field keeps Escape, so a draft is never thrown away by leaving the page. Popups close on a document
    // listener, and window hears the key after it, so an Escape that closed a popup arrives defaultPrevented.
    { target: window, ignoreInputs: true, preventDefault: false, stopPropagation: false },
  )

  const navItem = (item: SettingsPage) => (
    <li key={item.id}>
      <button
        type="button"
        aria-current={item.id === page?.id ? "page" : undefined}
        onClick={() => void navigate({ search: (previous) => ({ ...previous, page: item.id }), replace: true })}
        className="pressable flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-muted aria-[current=page]:font-medium aria-[current=page]:text-foreground"
      >
        <item.icon aria-hidden className="size-4 shrink-0" />
        {item.label()}
      </button>
    </li>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center border-b border-border px-6">
        <h1 className="text-sm font-semibold">{m.settings_title()}</h1>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={m.settings_sections()}
          className="flex w-52 shrink-0 flex-col gap-4 border-r border-border p-2"
        >
          <section aria-labelledby="settings-group-app" className="flex flex-col gap-1">
            <h2 id="settings-group-app" className="px-2 pt-1 text-xs font-medium text-muted-foreground">
              {m.settings_group_app()}
            </h2>
            <ul className="flex flex-col gap-0.5">{shown.filter((item) => item.scope === "app").map(navItem)}</ul>
          </section>
          <section aria-labelledby="settings-group-environment" className="flex flex-col gap-1">
            {clouds.length === 0 ? (
              <h2 id="settings-group-environment" className="px-2 pt-1 text-xs font-medium text-muted-foreground">
                {m.environment_this_machine()}
              </h2>
            ) : (
              <EnvironmentPicker
                labelId="settings-group-environment"
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
            <ul className="flex flex-col gap-0.5">
              {shown.filter((item) => item.scope === "environment").map(navItem)}
            </ul>
          </section>
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="w-full max-w-2xl px-8 py-6">
            {page?.scope === "environment" ? (
              // Keyed by environment so drafts in the page's fields never carry over to another machine.
              <EnvironmentPage key={environment ?? ""} environment={environment} page={page} />
            ) : (
              page && <page.component />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Radio value of this machine, which has no environment id. */
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
    <div className="flex flex-col gap-1 px-2 pt-1">
      <h2 id={labelId} className="text-xs font-medium text-muted-foreground">
        {m.settings_editing_for()}
      </h2>
      <Select
        items={items}
        value={value ?? THIS_MACHINE}
        onValueChange={(next) => typeof next === "string" && onChange(next === THIS_MACHINE ? null : next)}
      >
        <SelectTrigger aria-labelledby={labelId} size="sm" className="w-full">
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

/** An environment's page, once that environment's settings answered, so its fields never start from defaults. */
function EnvironmentPage({ environment, page }: { environment: EnvironmentId; page: SettingsPage }) {
  const settings = useAtomValue(settingsAtom(environment))
  const refresh = useAtomRefresh(settingsAtom(environment))
  const name = environmentName(environment, useClouds())

  return AsyncResult.builder(settings)
    .onInitial(() => <p className="text-sm text-muted-foreground">{m.settings_environment_loading({ name })}</p>)
    .onSuccess(() => <page.component />)
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
