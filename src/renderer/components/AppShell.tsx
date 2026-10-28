import { Outlet, useRouter } from "@tanstack/react-router"
import { useEffect, useRef } from "react"
import { useKeybindings } from "../keybindings/useKeybindings.ts"
import { usePanelLayout } from "../lib/panelLayout.ts"
import { useAgentUpdateNotices } from "./AgentUpdateNotices.tsx"
import { CommandPalette } from "./CommandPalette.tsx"
import { SnoozeDialog } from "./SnoozeDialog.tsx"
import { Sidebar } from "./Sidebar.tsx"
import { ThreadSwitcher } from "./ThreadSwitcher.tsx"
import { TitleBar } from "./TitleBar.tsx"

/** The mouse's back and forward side buttons walk the router history, as they do in a browser. */
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
  const compact = usePanelLayout() === "compact"
  const sidebarButtonRef = useRef<HTMLButtonElement>(null)

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <TitleBar compact={compact} sidebarButtonRef={sidebarButtonRef} />
      <div className="flex min-h-0 flex-1">
        <Sidebar compact={compact} finalFocus={sidebarButtonRef} />
        <main className="flex min-w-0 flex-1 flex-col">
          <Outlet />
        </main>
      </div>
      <CommandPalette />
      <ThreadSwitcher />
      <SnoozeDialog />
    </div>
  )
}
