import { useNavigate, useRouter, useSearch } from "@tanstack/react-router"
import { useRef, useState } from "react"
import type { IconType } from "react-icons"
import {
  RiArrowLeftLine,
  RiCpuLine,
  RiFlaskLine,
  RiFlashlightLine,
  RiGitBranchLine,
  RiKeyboardLine,
  RiNotification3Line,
  RiPaletteLine,
  RiPlugLine,
  RiServerLine,
  RiSettings3Line,
} from "react-icons/ri"
import { usePanelLayout } from "../../lib/panelLayout.ts"
import { SIDEBAR_BOUNDS, SIDEBAR_DEFAULT_WIDTH } from "../../lib/panelSize.ts"
import { m } from "../../paraglide/messages.js"
import { useUi } from "../../stores/ui.ts"
import { ResizeHandle } from "../ResizeHandle.tsx"
import { Button } from "../ui/button.tsx"
import { Input } from "../ui/input.tsx"
import { ScrollArea } from "../ui/scroll-area.tsx"

export interface SettingsPage {
  readonly id: string
  readonly scope: "app" | "environment"
  readonly label: () => string
  readonly description?: () => string
  readonly icon: IconType
  readonly keywords: ReadonlyArray<() => string>
}

export const settingsPages: ReadonlyArray<SettingsPage> = [
  {
    id: "general",
    scope: "app",
    label: m.settings_general,
    icon: RiSettings3Line,
    keywords: [m.settings_language, m.settings_version],
  },
  {
    id: "appearance",
    scope: "app",
    label: m.settings_appearance,
    icon: RiPaletteLine,
    keywords: [m.settings_theme, m.settings_contrast, m.settings_font_size],
  },
  {
    id: "notifications",
    scope: "app",
    label: m.settings_notifications,
    description: m.settings_notifications_hint,
    icon: RiNotification3Line,
    keywords: [
      m.settings_notifications_completed,
      m.settings_notifications_needs_input,
      m.settings_notifications_failed,
      m.settings_notifications_sound,
    ],
  },
  {
    id: "keybindings",
    scope: "app",
    label: m.settings_keybindings,
    description: m.settings_keybindings_hint,
    icon: RiKeyboardLine,
    keywords: [],
  },
  {
    id: "providers",
    scope: "environment",
    label: m.settings_providers,
    description: m.settings_models_hint,
    icon: RiCpuLine,
    keywords: [
      m.settings_default_model,
      m.settings_default_account,
      m.settings_default_access,
      m.settings_model_preset,
      m.settings_auto_compact,
      m.settings_text_generation_model,
    ],
  },
  {
    id: "worktrees",
    scope: "environment",
    label: m.settings_worktrees,
    description: m.settings_worktrees_description,
    icon: RiGitBranchLine,
    keywords: [
      m.settings_worktree_root,
      m.settings_archive,
      m.settings_archive_when_merged,
      m.settings_archive_remove_worktree,
    ],
  },
  {
    id: "integrations",
    scope: "environment",
    label: m.settings_integrations,
    icon: RiPlugLine,
    keywords: [m.settings_github_label, m.settings_linear_label, m.settings_slack_label],
  },
  {
    id: "automations",
    scope: "environment",
    label: m.settings_automations,
    description: m.automations_description,
    icon: RiFlashlightLine,
    keywords: [m.automations_bind_label],
  },
  {
    id: "connections",
    scope: "app",
    label: m.settings_connections,
    description: m.environments_description,
    icon: RiServerLine,
    keywords: [
      m.environment_relay_owner_token_label,
      m.environment_pairing_url_label,
      m.settings_remote,
      m.remote_enable_label,
    ],
  },
  {
    id: "experimental",
    scope: "environment",
    label: m.settings_experimental,
    description: m.settings_experimental_hint,
    icon: RiFlaskLine,
    keywords: [m.settings_tiny_vm, m.settings_devices],
  },
]

export const settingsPageOf = (id: string | undefined) =>
  settingsPages.find((page) => page.id === id) ?? settingsPages[0]!

export function useLeaveSettings() {
  const navigate = useNavigate()
  const { history } = useRouter()
  return () => {
    if (history.canGoBack()) history.back()
    else void navigate({ to: "/" })
  }
}

interface SearchResult {
  readonly page: SettingsPage
  readonly setting?: string
}

const search = (query: string): ReadonlyArray<SearchResult> => {
  const matches = (text: string) => text.toLocaleLowerCase().includes(query)
  return settingsPages.flatMap((page) =>
    matches(page.label())
      ? [{ page }]
      : page.keywords
          .map((keyword) => keyword())
          .filter(matches)
          .map((setting) => ({ page, setting })),
  )
}

export function SettingsNav() {
  const { page: pageId } = useSearch({ strict: false })
  const current = settingsPageOf(pageId)
  const navigate = useNavigate()
  const onLeave = useLeaveSettings()
  const onOpen = (id: string) =>
    void navigate({ to: "/settings", search: (previous) => ({ ...previous, page: id }), replace: true })
  const compact = usePanelLayout() === "compact"
  const sidebarOpen = useUi((state) => state.sidebarOpen)
  const sidebarWidth = useUi((state) => state.sidebarWidth)
  const setSidebarWidth = useUi((state) => state.setSidebarWidth)
  const navRef = useRef<HTMLElement>(null)
  const [query, setQuery] = useState("")
  const trimmed = query.trim().toLocaleLowerCase()
  const results: ReadonlyArray<SearchResult> =
    trimmed === "" ? settingsPages.map((page) => ({ page })) : search(trimmed)

  return (
    <nav
      ref={navRef}
      aria-label={m.settings_sections()}
      hidden={!compact && !sidebarOpen}
      data-compact={compact}
      style={compact ? undefined : { width: sidebarWidth }}
      className="relative flex min-h-0 shrink-0 flex-col border-r border-sidebar-border bg-sidebar glass:bg-sidebar/80 text-sidebar-foreground before:absolute before:-right-px before:bottom-full before:h-titlebar before:w-px before:bg-sidebar-border data-[compact=false]:flex-1 data-[compact=true]:w-52"
    >
      <div className="flex flex-col gap-1 px-2 pt-2 pb-1">
        <Button variant="ghost" size="sm" onClick={onLeave} className="justify-start text-muted-foreground">
          <RiArrowLeftLine aria-hidden />
          {m.settings_back()}
        </Button>
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            const first = results[0]
            if (event.key === "Enter" && first) onOpen(first.page.id)
          }}
          aria-label={m.settings_search()}
          placeholder={m.settings_search()}
          className="h-7 text-sm glass:glass-field"
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {results.length === 0 ? (
          <p className="px-4 py-2 text-xs text-muted-foreground">{m.settings_search_empty()}</p>
        ) : (
          <ul className="flex flex-col gap-0.5 px-2 pt-1 pb-3">
            {results.map(({ page, setting }) => (
              <li key={`${page.id}:${setting ?? ""}`}>
                <button
                  type="button"
                  aria-current={page.id === current.id && setting === undefined ? "page" : undefined}
                  onClick={() => onOpen(page.id)}
                  className="pressable flex w-full items-center gap-2 rounded-md [--press-scale:0.99] px-2 py-1.5 text-left text-sm text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground"
                >
                  <page.icon aria-hidden className="size-4 shrink-0 self-start mt-0.5" />
                  {setting === undefined ? (
                    page.label()
                  ) : (
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sidebar-foreground">{setting}</span>
                      <span className="text-xs">{page.label()}</span>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
      {!compact && sidebarOpen && (
        <ResizeHandle
          label={m.sidebar_resize()}
          edge="right"
          targetRef={navRef}
          bounds={SIDEBAR_BOUNDS}
          onResize={setSidebarWidth}
          onReset={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
        />
      )}
    </nav>
  )
}
