import { getRouteApi } from "@tanstack/react-router"
import { ThreadSidePanel } from "../components/ThreadSidePanel.tsx"
import { ThreadHeader, ThreadView } from "../components/ThreadView.tsx"
import { m } from "../paraglide/messages.js"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"

const route = getRouteApi("/thread/$threadId")

export function ThreadRoute() {
  const { threadId } = route.useParams()
  const thread = useThreads((state) => state.byId[threadId])
  const panelOpen = useUi((state) => state.sidePanelOpen)

  if (!thread) {
    return <p className="m-auto text-sm text-muted-foreground">{m.thread_not_found()}</p>
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ThreadHeader thread={thread} />
      <div className="flex min-h-0 flex-1">
        <ThreadView key={`view-${thread.id}`} thread={thread} />
        {panelOpen && <ThreadSidePanel key={`panel-${thread.id}`} thread={thread} />}
      </div>
    </div>
  )
}
