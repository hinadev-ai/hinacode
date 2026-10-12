import { Outlet } from "@tanstack/react-router"
import { type RefObject, useRef } from "react"
import { RiSideBarLine } from "react-icons/ri"
import { useKeybindings, useKeymap } from "../keybindings/useKeybindings.ts"
import { m } from "../paraglide/messages.js"
import { useUi } from "../stores/ui.ts"
import { usePanelLayout } from "../lib/panelLayout.ts"
import { ChordKeys } from "./ChordKeys.tsx"
import { Sidebar } from "./Sidebar.tsx"
import { Button } from "./ui/button.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

export function AppShell() {
  useKeybindings()
  const sidebarOpen = useUi((state) => state.sidebarOpen)
  const compact = usePanelLayout() === "compact"
  const sidebarButtonRef = useRef<HTMLButtonElement>(null)

  return (
    <div className="flex h-dvh bg-background text-foreground">
      <Sidebar compact={compact} finalFocus={sidebarButtonRef} />
      {(compact || !sidebarOpen) && <SidebarRail buttonRef={sidebarButtonRef} />}
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  )
}

/** What is left of the sidebar while it is hidden: one button to bring it back. */
function SidebarRail({ buttonRef }: { buttonRef: RefObject<HTMLButtonElement | null> }) {
  const toggleSidebar = useUi((state) => state.toggleSidebar)
  const chord = useKeymap()["sidebar.toggle"]

  return (
    <div className="flex w-11 shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar py-2.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              ref={buttonRef}
              variant="ghost"
              size="icon-sm"
              aria-label={m.sidebar_show()}
              onClick={toggleSidebar}
            />
          }
        >
          <RiSideBarLine aria-hidden />
        </TooltipTrigger>
        <TooltipContent side="right">
          {m.sidebar_show()}
          {chord && <ChordKeys chord={chord} />}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
