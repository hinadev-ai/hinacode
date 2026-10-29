import type { Thread } from "../../../shared/domain.ts"
import { ThreadDiff } from "../ThreadDiff.tsx"
import { ScrollArea } from "../ui/scroll-area.tsx"

export function ChangesView({ thread }: { thread: Thread }) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <ThreadDiff thread={thread} />
    </ScrollArea>
  )
}
