import { Outlet } from "@tanstack/react-router"
import { useRef } from "react"
import { useKeybindings } from "../keybindings/useKeybindings.ts"
import { usePanelLayout } from "../lib/panelLayout.ts"
import { CommandPalette } from "./CommandPalette.tsx"
import { Sidebar } from "./Sidebar.tsx"
import { StatusBar } from "./StatusBar.tsx"
import { TitleBar } from "./TitleBar.tsx"

export function AppShell() {
  useKeybindings()
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
      <StatusBar />
      <CommandPalette />
    </div>
  )
}
