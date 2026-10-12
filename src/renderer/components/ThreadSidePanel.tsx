import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { cn } from "cn"
import { createElement, type RefObject, useCallback, useEffect, useRef } from "react"
import { RiSideBarFill } from "react-icons/ri"
import type { Thread } from "../../shared/domain.ts"
import { usePanelLayout } from "../lib/panelLayout.ts"
import { SIDE_PANEL_BOUNDS } from "../lib/panelWidth.ts"
import { m } from "../paraglide/messages.js"
import { selectSidePanelView, useUi } from "../stores/ui.ts"
import { ResizeHandle } from "./ResizeHandle.tsx"
import { ActivityBar } from "./sidePanel/ActivityBar.tsx"
import { viewById } from "./sidePanel/views.ts"
import { Button } from "./ui/button.tsx"

/** Hiding the panel (mod+.) takes the focused element with it; hand focus to the composer instead of <body>. */
const returnFocusToComposer = (panel: HTMLElement | null) => () => {
  if (panel?.contains(document.activeElement)) useUi.getState().requestComposerFocus()
}

/**
 * Right-hand side of the thread route: the selected view and, on the right edge, the activity bar that
 * picks it. Docked, the bar stays while the view hides. `compact` is the overlay, where both show.
 */
export function ThreadSidePanel({ thread, compact = false }: { thread: Thread; compact?: boolean }) {
  const docked = usePanelLayout() === "wide"
  const open = useUi((state) => (docked ? state.sidePanelOpen : state.sidePanelOverlayOpen))
  const viewId = useUi(selectSidePanelView(thread.id))
  const shown = compact || open
  const panelId = `side-panel-${thread.id}`

  return (
    <aside
      aria-label={m.panel_label()}
      className={cn("flex min-h-0 shrink-0", compact ? "w-full flex-1" : "border-l border-border")}
    >
      {shown && <ViewContent thread={thread} viewId={viewId} panelId={panelId} compact={compact} />}
      <ActivityBar threadId={thread.id} selected={shown ? viewId : null} panelId={panelId} />
    </aside>
  )
}

interface ViewContentProps {
  readonly thread: Thread
  readonly viewId: ReturnType<ReturnType<typeof selectSidePanelView>>
  readonly panelId: string
  readonly compact: boolean
}

function ViewContent({ thread, viewId, panelId, compact }: ViewContentProps) {
  const view = viewById(viewId)
  const size = useUi((state) => (state.sidePanelWide ? "wide" : "normal"))
  const width = useUi((state) => state.sidePanelWidths[size])
  const setWidth = useUi((state) => state.setSidePanelWidth)
  const toggleSidePanel = useUi((state) => state.toggleSidePanel)
  const ref = useRef<HTMLElement | null>(null)
  const setRef = useCallback((node: HTMLElement | null) => {
    ref.current = node
    return returnFocusToComposer(node)
  }, [])

  // A view shortcut moves focus into the view. Files focuses its own tree once it has listed the root.
  const focusRequest = useUi((state) => state.viewFocusRequest)
  useEffect(() => {
    if (focusRequest === null || focusRequest !== viewId || viewId === "files") return
    useUi.getState().clearViewFocusRequest()
    ref.current?.focus()
  }, [focusRequest, viewId])

  return (
    <section
      ref={setRef}
      id={panelId}
      role="tabpanel"
      tabIndex={-1}
      aria-label={view.title()}
      style={compact || width === null ? undefined : { width }}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col outline-none",
        compact ? "flex-1" : "max-w-[50vw] transition-[width] duration-200 ease-out motion-reduce:transition-none",
        !compact && (size === "wide" ? "w-[min(44rem,50vw)]" : "w-96"),
      )}
    >
      {!compact && (
        <ResizeHandle
          label={m.panel_resize()}
          edge="left"
          targetRef={ref}
          bounds={SIDE_PANEL_BOUNDS}
          onResize={(next) => setWidth(size, next)}
          onReset={() => setWidth(size, null)}
        />
      )}
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border pr-2 pl-4">
        <h2 className="truncate text-sm font-medium">{view.title()}</h2>
        <PanelToggle expanded onToggle={toggleSidePanel} closeDialog={compact} />
      </header>
      {createElement(view.component, { thread })}
    </section>
  )
}

export function PanelToggle({
  expanded,
  onToggle,
  buttonRef,
  closeDialog = false,
}: {
  expanded: boolean
  onToggle: () => void
  buttonRef?: RefObject<HTMLButtonElement | null>
  closeDialog?: boolean
}) {
  const label = expanded ? m.panel_hide() : m.panel_show()
  const button = (
    <Button
      ref={buttonRef}
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      onClick={closeDialog ? undefined : onToggle}
    >
      <RiSideBarFill aria-hidden className="-scale-x-100" />
    </Button>
  )
  return closeDialog ? <DialogPrimitive.Close render={button} /> : button
}
