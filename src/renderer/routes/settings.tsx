import { type ComponentType, useState } from "react"
import type { IconType } from "react-icons"
import { RiCpuLine, RiKeyboardLine, RiPlugLine, RiSettings3Line } from "react-icons/ri"
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
]

export function SettingsRoute() {
  const [pageId, setPageId] = useState(pages[0]?.id)
  const page = pages.find((candidate) => candidate.id === pageId) ?? pages[0]

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-52 shrink-0 flex-col gap-3 border-r border-border px-3 pt-2 pb-4">
        <h1 className="flex h-8 items-center px-2 text-sm font-medium">{m.settings_title()}</h1>
        <nav aria-label={m.settings_sections()}>
          <ul className="flex flex-col gap-px">
            {pages.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={item.id === page?.id ? "page" : undefined}
                  onClick={() => setPageId(item.id)}
                  className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm text-muted-foreground outline-none transition-colors duration-100 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:text-foreground"
                >
                  <item.icon aria-hidden className="size-4 shrink-0" />
                  {item.label()}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-10 py-10">{page && <page.component />}</div>
      </div>
    </div>
  )
}
