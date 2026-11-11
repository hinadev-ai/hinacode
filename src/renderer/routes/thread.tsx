import { getRouteApi } from "@tanstack/react-router"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { useEffect, useRef } from "react"
import { FloatingTinyVm } from "../components/FloatingTinyVm.tsx"
import { ThreadOpenWith } from "../components/OpenWith.tsx"
import { TerminalDrawer, TerminalToggle } from "../components/TerminalDrawer.tsx"
import { PanelToggle, ThreadSidePanel } from "../components/ThreadSidePanel.tsx"
import { ActionsMenu, ThreadOverview } from "../components/ThreadOverview.tsx"
import { ThreadView } from "../components/ThreadView.tsx"
import { Dialog, DialogPortal, DialogTitle } from "../components/ui/dialog.tsx"
import { usePanelLayout } from "../lib/panelLayout.ts"
import { m } from "../paraglide/messages.js"
import { selectOpenableThread, useThreads } from "../stores/threads.ts"
import { useSidePanelExpanded, useUi } from "../stores/ui.ts"
import { useUnseen } from "../stores/unseen.ts"

const route = getRouteApi("/thread/$threadId")

function useMarkSeen(threadId: string) {
  useEffect(() => {
    const markSeen = () => useUnseen.getState().clear(threadId)
    markSeen()
    window.addEventListener("focus", markSeen)
    return () => window.removeEventListener("focus", markSeen)
  }, [threadId])
}

function useVisit(threadId: string) {
  useEffect(() => useUi.getState().visitThread(threadId), [threadId])
}

export function ThreadRoute() {
  const { threadId } = route.useParams()
  const { agent } = route.useSearch()
  const thread = useThreads(selectOpenableThread(threadId))
  const togglePanel = useUi((state) => state.toggleSidePanel)
  const overlayOpen = useUi((state) => state.sidePanelOverlayOpen)
  const dockedOpen = useUi((state) => state.sidePanelOpen)
  const setOverlayOpen = useUi((state) => state.setSidePanelOverlayOpen)
  const docked = usePanelLayout() === "wide"
  const expanded = useSidePanelExpanded()
  const toggleRef = useRef<HTMLButtonElement>(null)
  useMarkSeen(threadId)
  useVisit(threadId)

  if (!thread) {
    return <p className="m-auto text-sm text-muted-foreground">{m.thread_not_found()}</p>
  }
  return (
    <div className="flex min-h-0 flex-1">
      <div hidden={expanded} className="flex min-w-0 flex-1 flex-col">
        <ThreadView
          key={thread.id}
          thread={thread}
          agent={agent}
          overlay={
            <>
              {agent === undefined && <ThreadOverview thread={thread} />}
              <FloatingTinyVm threadId={thread.id} />
            </>
          }
          actions={
            <>
              <ThreadOpenWith thread={thread} />
              <ActionsMenu thread={thread} />
              <TerminalToggle threadId={thread.id} />
              {!docked && <PanelToggle buttonRef={toggleRef} expanded={overlayOpen} onToggle={togglePanel} />}
              {docked && !dockedOpen && <PanelToggle expanded={false} onToggle={togglePanel} className="-me-1" />}
            </>
          }
        />
        <TerminalDrawer threadId={thread.id} />
      </div>
      {docked && <ThreadSidePanel key={thread.id} thread={thread} />}
      {!docked && (
        <Dialog open={overlayOpen} onOpenChange={setOverlayOpen}>
          <DialogPortal>
            <DialogPrimitive.Backdrop className="fixed inset-x-0 top-titlebar bottom-0 z-50 bg-background/60 transition-opacity duration-250 ease-drawer data-ending-style:opacity-0 data-ending-style:duration-200 data-starting-style:opacity-0" />
            <DialogPrimitive.Popup
              finalFocus={toggleRef}
              className="fixed top-titlebar right-0 bottom-0 z-50 flex w-[calc(24rem+2.75rem)] max-w-full flex-col overflow-hidden border-l border-border bg-background transition-[translate,opacity] duration-250 ease-drawer outline-none data-ending-style:duration-200 motion-safe:data-ending-style:translate-x-full motion-safe:data-starting-style:translate-x-full motion-reduce:data-ending-style:opacity-0 motion-reduce:data-starting-style:opacity-0"
            >
              <DialogTitle className="sr-only">{m.panel_label()}</DialogTitle>
              <ThreadSidePanel key={thread.id} thread={thread} compact />
            </DialogPrimitive.Popup>
          </DialogPortal>
        </Dialog>
      )}
    </div>
  )
}
