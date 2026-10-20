import { getRouteApi } from "@tanstack/react-router"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { useEffect, useRef } from "react"
import { FloatingTinyVm } from "../components/FloatingTinyVm.tsx"
import { ThreadOpenWith } from "../components/OpenWith.tsx"
import { TerminalDrawer, TerminalToggle } from "../components/TerminalDrawer.tsx"
import { PanelToggle, ThreadSidePanel } from "../components/ThreadSidePanel.tsx"
import { ThreadView } from "../components/ThreadView.tsx"
import { Dialog, DialogPortal, DialogTitle } from "../components/ui/dialog.tsx"
import { usePanelLayout } from "../lib/panelLayout.ts"
import { m } from "../paraglide/messages.js"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { useUnseen } from "../stores/unseen.ts"

const route = getRouteApi("/thread/$threadId")

/** Opening a thread shows its latest result. While the window is in the background, the result waits for focus. */
function useMarkSeen(threadId: string) {
  useEffect(() => {
    const markSeen = () => useUnseen.getState().clear(threadId)
    markSeen()
    window.addEventListener("focus", markSeen)
    return () => window.removeEventListener("focus", markSeen)
  }, [threadId])
}

export function ThreadRoute() {
  const { threadId } = route.useParams()
  const { agent } = route.useSearch()
  const thread = useThreads((state) => state.byId[threadId])
  const togglePanel = useUi((state) => state.toggleSidePanel)
  const overlayOpen = useUi((state) => state.sidePanelOverlayOpen)
  const setOverlayOpen = useUi((state) => state.setSidePanelOverlayOpen)
  const docked = usePanelLayout() === "wide"
  const toggleRef = useRef<HTMLButtonElement>(null)
  useMarkSeen(threadId)

  if (!thread) {
    return <p className="m-auto text-sm text-muted-foreground">{m.thread_not_found()}</p>
  }
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <ThreadView
          key={thread.id}
          thread={thread}
          agent={agent}
          overlay={<FloatingTinyVm threadId={thread.id} />}
          actions={
            <>
              <ThreadOpenWith thread={thread} />
              <TerminalToggle threadId={thread.id} />
              {!docked && <PanelToggle buttonRef={toggleRef} expanded={overlayOpen} onToggle={togglePanel} />}
            </>
          }
        />
        <TerminalDrawer threadId={thread.id} />
      </div>
      {docked && <ThreadSidePanel key={thread.id} thread={thread} />}
      {!docked && (
        <Dialog open={overlayOpen} onOpenChange={setOverlayOpen}>
          <DialogPortal>
            <DialogPrimitive.Backdrop className="fixed inset-x-0 top-titlebar bottom-0 z-50 bg-background/60" />
            <DialogPrimitive.Popup
              finalFocus={toggleRef}
              className="fixed top-titlebar right-0 bottom-0 z-50 flex w-[calc(24rem+2.75rem)] max-w-full flex-col overflow-hidden border-l border-border bg-background outline-none"
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
