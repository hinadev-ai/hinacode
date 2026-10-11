import { type ComponentType, useState } from "react"
import type { IconType } from "react-icons"
import { RiCpuLine, RiFlashlightLine, RiKeyboardLine, RiPlugLine, RiSettings3Line } from "react-icons/ri"
import { AutomationSettings } from "../components/settings/automations/AutomationSettings.tsx"
import { GeneralSettings } from "../components/settings/GeneralSettings.tsx"
import { IntegrationSettings } from "../components/settings/IntegrationSettings.tsx"
import { KeybindingSettings } from "../components/settings/KeybindingSettings.tsx"
import { ModelSettings } from "../components/settings/ModelSettings.tsx"
import { m } from "../paraglide/messages.js"

interface SettingsPage {
  readonly id: string
  readonly label: () => string
  readonly icon: IconType
  readonly component: ComponentType
}

const pages: ReadonlyArray<SettingsPage> = [
  { id: "general", label: m.settings_general, icon: RiSettings3Line, component: GeneralSettings },
  { id: "models", label: m.settings_models, icon: RiCpuLine, component: ModelSettings },
  { id: "keybindings", label: m.settings_keybindings, icon: RiKeyboardLine, component: KeybindingSettings },
  { id: "integrations", label: m.settings_integrations, icon: RiPlugLine, component: IntegrationSettings },
  { id: "automations", label: m.settings_automations, icon: RiFlashlightLine, component: AutomationSettings },
]

export function SettingsRoute() {
  const [pageId, setPageId] = useState(pages[0]?.id)
  const page = pages.find((candidate) => candidate.id === pageId) ?? pages[0]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center border-b border-border px-6">
        <h1 className="text-sm font-semibold">{m.settings_title()}</h1>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label={m.settings_sections()} className="w-52 shrink-0 border-r border-border p-2">
          <ul className="flex flex-col gap-0.5">
            {pages.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={item.id === page?.id ? "page" : undefined}
                  onClick={() => setPageId(item.id)}
                  className="pressable flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-muted aria-[current=page]:font-medium aria-[current=page]:text-foreground"
                >
                  <item.icon aria-hidden className="size-4 shrink-0" />
                  {item.label()}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="w-full max-w-2xl px-8 py-6">{page && <page.component />}</div>
        </div>
      </div>
    </div>
  )
}
