import { useAtomValue } from "@effect/atom-react"
import { detectPlatform } from "@tanstack/react-hotkeys"
import { Link } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { type RefObject, useEffect } from "react"
import { RiSettings3Line, RiSideBarFill, RiSideBarLine } from "react-icons/ri"
import { useKeymap } from "../keybindings/useKeybindings.ts"
import { projectsAtom } from "../lib/rpc.ts"
import { windowProjectId } from "../lib/windowProject.ts"
import { m } from "../paraglide/messages.js"
import { useUi } from "../stores/ui.ts"
import { cn } from "../lib/utils.ts"
import { ChordKeys } from "./ChordKeys.tsx"
import { Button } from "./ui/button.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

// The main process hides the native title bar on macOS only, and the traffic lights sit in this bar's left inset.
const besideTrafficLights = detectPlatform() === "mac"

export function TitleBar({
  compact,
  sidebarButtonRef,
}: {
  compact: boolean
  sidebarButtonRef: RefObject<HTMLButtonElement | null>
}) {
  const sidebarShown = useUi((state) => (compact ? state.sidebarOverlayOpen : state.sidebarOpen))
  const toggleSidebar = useUi((state) => state.toggleSidebar)
  const chord = useKeymap()["sidebar.toggle"]
  const sidebarLabel = sidebarShown ? m.sidebar_hide() : m.sidebar_show()
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => [])
  const windowProject = projects.find((project) => project.id === windowProjectId)

  // The native window takes the document title, which names the window in the Window menu and Mission Control.
  useEffect(() => {
    if (windowProject) document.title = m.window_title_project({ project: windowProject.name })
  }, [windowProject])

  return (
    <header
      className={cn(
        "window-drag flex h-titlebar shrink-0 items-center gap-0.5 border-b border-sidebar-border bg-sidebar pr-2 text-sidebar-foreground select-none",
        besideTrafficLights ? "pl-22" : "pl-3",
      )}
    >
      <span className="mr-3 truncate font-heading text-sm font-semibold">{windowProject?.name ?? m.app_name()}</span>
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
          {sidebarShown ? <RiSideBarFill aria-hidden /> : <RiSideBarLine aria-hidden />}
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {sidebarLabel}
          {chord && <ChordKeys chord={chord} />}
        </TooltipContent>
      </Tooltip>
      <Button variant="ghost" size="icon-sm" render={<Link to="/settings" />} aria-label={m.sidebar_settings()}>
        <RiSettings3Line aria-hidden />
      </Button>
    </header>
  )
}
