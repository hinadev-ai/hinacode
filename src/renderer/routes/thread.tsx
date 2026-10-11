import { getRouteApi } from "@tanstack/react-router"
import { PanelToggle, ThreadSidePanel } from "../components/ThreadSidePanel.tsx"
import { ThreadView } from "../components/ThreadView.tsx"
import { m } from "../paraglide/messages.js"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"

const route = getRouteApi("/thread/$threadId")

export function ThreadRoute() {
  const { threadId } = route.useParams()
  const thread = useThreads((state) => state.byId[threadId])
  const panelOpen = useUi((state) => state.sidePanelOpen)
  const togglePanel = useUi((state) => state.toggleSidePanel)

  if (!thread) {
    return <p className="m-auto text-sm text-muted-foreground">{m.thread_not_found()}</p>
  }
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <ThreadView key={thread.id} thread={thread} />
      </div>
      {panelOpen ? (
        <ThreadSidePanel key={thread.id} thread={thread} />
      ) : (
        <div className="flex h-12 shrink-0 items-center border-b border-l border-border px-2">
          <PanelToggle expanded={false} onToggle={togglePanel} />
        </div>
      )}
    </div>
  )
}
