import { getRouteApi } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { tinykeys } from "tinykeys"
import { PanelToggle, ThreadSidePanel } from "../components/ThreadSidePanel.tsx"
import { ThreadView } from "../components/ThreadView.tsx"
import { m } from "../paraglide/messages.js"
import { useThreads } from "../stores/threads.ts"

const route = getRouteApi("/thread/$threadId")

export function ThreadRoute() {
  const { threadId } = route.useParams()
  const thread = useThreads((state) => state.byId[threadId])
  const [panelOpen, setPanelOpen] = useState(true)
  const togglePanel = () => setPanelOpen((open) => !open)

  useEffect(() => tinykeys(window, { "$mod+Period": () => setPanelOpen((open) => !open) }), [])

  if (!thread) {
    return <p className="m-auto text-sm text-muted-foreground">{m.thread_not_found()}</p>
  }
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <ThreadView key={thread.id} thread={thread} />
      </div>
      {panelOpen ? (
        <ThreadSidePanel key={thread.id} thread={thread} onHide={togglePanel} />
      ) : (
        <div className="flex h-12 shrink-0 items-center border-b border-l border-border px-2">
          <PanelToggle expanded={false} onToggle={togglePanel} />
        </div>
      )}
    </div>
  )
}
