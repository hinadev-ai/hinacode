import { Outlet, useMatchRoute, useRouter } from "@tanstack/react-router"
import { useEffect, useRef } from "react"
import { useKeybindings } from "../keybindings/useKeybindings.ts"
import { usePanelLayout } from "../lib/panelLayout.ts"
import { useUi } from "../stores/ui.ts"
import { useAgentUpdateNotices } from "./AgentUpdateNotices.tsx"
import { useGitHubRateLimitNotices } from "./GitHubRateLimitNotices.tsx"
import { CommandPalette } from "./CommandPalette.tsx"
import { SnoozeDialog } from "./SnoozeDialog.tsx"
import { SettingsNav } from "./settings/SettingsNav.tsx"
import { Sidebar } from "./Sidebar.tsx"
import { ThreadSwitcher } from "./ThreadSwitcher.tsx"
import { TitleBar } from "./TitleBar.tsx"

function useMouseHistoryButtons() {
  const { history } = useRouter()
  useEffect(() => {
    const listener = (event: MouseEvent) => {
      if (event.button === 3) history.back()
      else if (event.button === 4) history.forward()
    }
    window.addEventListener("mouseup", listener)
    return () => window.removeEventListener("mouseup", listener)
  }, [history])
}

export function AppShell() {
  useKeybindings()
  useMouseHistoryButtons()
  useAgentUpdateNotices()
  useGitHubRateLimitNotices()
  const compact = usePanelLayout() === "compact"
  const sidebarOpen = useUi((state) => state.sidebarOpen)
  const sidebarButtonRef = useRef<HTMLButtonElement>(null)
  const onSettings = useMatchRoute()({ to: "/settings" }) !== false

  const docked = !compact && sidebarOpen
  const titleBar = (
    <TitleBar
      compact={compact}
      sidebarButtonRef={sidebarButtonRef}
      className={docked ? "border-r border-sidebar-border" : undefined}
    />
  )

  return (
    <div className="flex h-dvh flex-col text-foreground">
      {!docked && titleBar}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 shrink-0 flex-col">
          {docked && <div className="w-0 min-w-full overflow-hidden">{titleBar}</div>}
          {docked && onSettings && <SettingsNav />}
          <Sidebar compact={compact} replaced={onSettings} finalFocus={sidebarButtonRef} />
        </div>
        <main className="flex min-w-0 flex-1 flex-col bg-background">
          <Outlet />
        </main>
      </div>
      <CommandPalette />
      <ThreadSwitcher />
      <SnoozeDialog />
    </div>
  )
}
