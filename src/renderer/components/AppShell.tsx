import { Outlet } from "@tanstack/react-router"
import { RiSideBarLine } from "react-icons/ri"
import { useKeybindings, useKeymap } from "../keybindings/useKeybindings.ts"
import { m } from "../paraglide/messages.js"
import { useUi } from "../stores/ui.ts"
import { ChordKeys } from "./ChordKeys.tsx"
import { Sidebar } from "./Sidebar.tsx"
import { Button } from "./ui/button.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

export function AppShell() {
  useKeybindings()
  const sidebarOpen = useUi((state) => state.sidebarOpen)

  return (
    <div className="flex h-dvh bg-canvas text-foreground">
      <Sidebar />
      {!sidebarOpen && <SidebarRail />}
      <main className="my-1.5 mr-1.5 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-background shadow-[0_1px_2px_oklch(0_0_0/40%),0_8px_24px_-12px_oklch(0_0_0/60%)]">
        <Outlet />
      </main>
    </div>
  )
}

/** What is left of the sidebar while it is hidden: one button to bring it back. */
function SidebarRail() {
  const toggleSidebar = useUi((state) => state.toggleSidebar)
  const chord = useKeymap()["sidebar.toggle"]

  return (
    <div className="flex w-11 shrink-0 flex-col items-center pt-[15px]">
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={m.sidebar_show()} onClick={toggleSidebar} />}
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
