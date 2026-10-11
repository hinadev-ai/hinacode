import { getRouteApi } from "@tanstack/react-router"
import { ThreadView } from "../components/ThreadView.tsx"
import { m } from "../paraglide/messages.js"
import { useThreads } from "../stores/threads.ts"

const route = getRouteApi("/thread/$threadId")

export function ThreadRoute() {
  const { threadId } = route.useParams()
  const thread = useThreads((state) => state.byId[threadId])

  if (!thread) {
    return <p className="m-auto text-sm text-muted-foreground">{m.thread_not_found()}</p>
  }
  return <ThreadView key={thread.id} thread={thread} />
}
