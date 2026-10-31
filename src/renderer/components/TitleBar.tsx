import { detectPlatform } from "@tanstack/react-hotkeys"
import { Link } from "@tanstack/react-router"
import type { RefObject } from "react"
import { useKeymap } from "../keybindings/useKeybindings.ts"
import { m } from "../paraglide/messages.js"
import { useUi } from "../stores/ui.ts"
import { cn } from "../lib/utils.ts"
import { ChordKeys } from "./ChordKeys.tsx"
import { MachineResourcesButton } from "./MachineResources.tsx"
import { Button } from "./ui/button.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"
import { SettingsIcon } from "./icons/SettingsIcon.tsx"
import { SidebarFillIcon } from "./icons/SidebarFillIcon.tsx"
import { SidebarIcon } from "./icons/SidebarIcon.tsx"

const besideTrafficLights = detectPlatform() === "mac"

export function TitleBar({
  compact,
  sidebarButtonRef,
  className,
}: {
  compact: boolean
  sidebarButtonRef: RefObject<HTMLButtonElement | null>
  className?: string
}) {
  const sidebarShown = useUi((state) => (compact ? state.sidebarOverlayOpen : state.sidebarOpen))
  const toggleSidebar = useUi((state) => state.toggleSidebar)
  const chord = useKeymap()["sidebar.toggle"]
  const sidebarLabel = sidebarShown ? m.sidebar_hide() : m.sidebar_show()

  return (
    <header
      className={cn(
        "flex h-titlebar shrink-0 items-center gap-0.5 bg-sidebar pr-2 text-sidebar-foreground select-none window-drag glass:bg-sidebar/80",
        besideTrafficLights ? "pl-22" : "pl-3",
        className,
      )}
    >
      <span className="mr-3 font-heading text-sm font-semibold">{m.app_name()}</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              ref={sidebarButtonRef}
              variant="ghost"
              size="icon-sm"
              aria-label={sidebarLabel}
              onClick={toggleSidebar}
            />
          }
        >
          {sidebarShown ? <SidebarFillIcon aria-hidden /> : <SidebarIcon aria-hidden />}
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {sidebarLabel}
          {chord && <ChordKeys chord={chord} />}
        </TooltipContent>
      </Tooltip>
      <Button
        variant="ghost"
        size="icon-sm"
        render={<Link to="/settings" />}
        aria-label={m.sidebar_settings()}
        className="data-[status=active]:bg-sidebar-accent data-[status=active]:text-sidebar-accent-foreground"
      >
        <SettingsIcon aria-hidden />
      </Button>
      <MachineResourcesButton />
    </header>
  )
}
