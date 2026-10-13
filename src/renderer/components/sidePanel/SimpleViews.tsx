import type { Thread } from "../../../shared/domain.ts"
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
      <ThreadAgents thread={thread} />
    </ViewBody>
  )
}
