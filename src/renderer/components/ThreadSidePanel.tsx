import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { cn } from "cn"
import { createElement, type RefObject, Suspense, useEffect, useRef } from "react"
import { RiSideBarFill } from "react-icons/ri"
import type { Thread } from "../../shared/domain.ts"
import { usePanelLayout, useSidePanelMaxWidth } from "../lib/panelLayout.ts"
import { SIDE_PANEL_BOUNDS } from "../lib/panelSize.ts"
import { m } from "../paraglide/messages.js"
import { selectSidePanelView, useUi } from "../stores/ui.ts"
import { ResizeHandle } from "./ResizeHandle.tsx"
import { useThreadEnvironment } from "../lib/environments.ts"
import { ActivityBar } from "./sidePanel/ActivityBar.tsx"
import { type SidePanelView, useSidePanelViews, viewById } from "./sidePanel/views.ts"
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
  const views = useSidePanelViews(useThreadEnvironment(thread.id))
  const view = viewById(views, useUi(selectSidePanelView(thread.id)))
  const shown = compact || open
  const panelId = `side-panel-${thread.id}`

  return (
    <aside
      aria-label={m.panel_label()}
      className={cn("flex min-h-0 shrink-0", compact ? "w-full flex-1" : "border-l border-border")}
    >
      {shown && <ViewContent thread={thread} view={view} panelId={panelId} compact={compact} />}
      <ActivityBar threadId={thread.id} views={views} selected={shown ? view.id : null} panelId={panelId} />
    </aside>
  )
}

interface ViewContentProps {
  readonly thread: Thread
  readonly view: SidePanelView
  readonly panelId: string
  readonly compact: boolean
}

function ViewContent({ thread, view, panelId, compact }: ViewContentProps) {
  const viewId = view.id
  const maximum = useSidePanelMaxWidth()
  const content = createElement(view.component, { thread })
  const header = view.header && createElement(view.header, { thread })
  const size = useUi((state) => (state.sidePanelWide ? "wide" : "normal"))
  const width = useUi((state) => state.sidePanelWidths[size])
  const setWidth = useUi((state) => state.setSidePanelWidth)
  const toggleSidePanel = useUi((state) => state.toggleSidePanel)
  const ref = useRef<HTMLElement | null>(null)
  const setRef = (node: HTMLElement | null) => {
    ref.current = node
    return returnFocusToComposer(node)
  }

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
      style={compact ? undefined : { width: width ?? undefined, maxWidth: maximum }}
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
          bounds={{ min: SIDE_PANEL_BOUNDS.min, max: maximum }}
          onResize={(next) => setWidth(size, next)}
          onReset={() => setWidth(size, null)}
        />
      )}
      <header className={cn("flex h-12 shrink-0 items-center justify-between gap-2 pr-2", header ? "pl-2" : "pl-4")}>
        {header ?? <h2 className="truncate text-sm font-medium">{view.title()}</h2>}
        <PanelToggle expanded onToggle={toggleSidePanel} closeDialog={compact} />
      </header>
      <Suspense>{content}</Suspense>
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
