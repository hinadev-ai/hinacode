import type { Thread } from "@shared/domain.ts"

/** The newest pull request linked to a thread, as `#123` with its state, for a thread row. */
export function PullRequestBadge(_props: { threadId: string }) {
  return null
}

/** The thread's pull request in the thread header. Pressing it opens the PRs tab. */
export function ThreadPullRequestChip(_props: { thread: Thread; onPress: () => void }) {
  return null
}
