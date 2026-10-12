import type { Thread } from "../../../shared/domain.ts"
import { m } from "../../paraglide/messages.js"
import { ThreadAgents } from "../ThreadAgents.tsx"
import { ThreadPullRequests } from "../ThreadPullRequests.tsx"
import { ViewBody } from "./Section.tsx"

export function PullRequestsView({ thread }: { thread: Thread }) {
  return (
    <ViewBody>
      <ThreadPullRequests thread={thread} />
    </ViewBody>
  )
}

export function AgentsView({ thread }: { thread: Thread }) {
  return (
    <ViewBody>
      <ThreadAgents threadId={thread.id} />
    </ViewBody>
  )
}

/** Stands in until the git graph lands. */
export function GitView() {
  return (
    <ViewBody>
      <p className="text-xs text-muted-foreground">{m.git_view_empty()}</p>
    </ViewBody>
  )
}
