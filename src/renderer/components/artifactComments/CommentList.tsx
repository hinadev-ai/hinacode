import { ChevronRightIcon } from "@hinacode/icons"
import type { ArtifactComment } from "../../../shared/artifact.ts"
import { m } from "../../paraglide/messages.js"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx"
import { CommentThread } from "./CommentThread.tsx"
import type { FeedbackActions } from "./feedback.ts"

export function CommentList({
  threadId,
  comments,
  actions,
  detached,
  focused,
  onShowAnchor,
}: {
  threadId: string
  comments: ReadonlyArray<ArtifactComment>
  actions: FeedbackActions
  detached: ReadonlySet<string>
  focused?: string | null
  onShowAnchor?: (comment: ArtifactComment) => void
}) {
  const open = comments.filter((comment) => !comment.resolved)
  const resolved = comments.filter((comment) => comment.resolved)
  const thread = (comment: ArtifactComment) => (
    <li key={comment.id}>
      <CommentThread
        threadId={threadId}
        comment={comment}
        actions={actions}
        detached={detached.has(comment.id)}
        focused={comment.id === focused}
        {...(onShowAnchor !== undefined && { onShowAnchor })}
      />
    </li>
  )
  if (comments.length === 0) return <p className="p-3 text-xs text-muted-foreground">{m.comments_empty()}</p>
  return (
    <div className="flex flex-col gap-3 p-3">
      {open.length > 0 && <ul className="flex flex-col gap-3">{open.map(thread)}</ul>}
      {resolved.length > 0 && (
        <Collapsible className="flex flex-col gap-3">
          <CollapsibleTrigger className="group/resolved flex items-center gap-1 self-start rounded-md px-1 py-0.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 transition-transform group-data-panel-open/resolved:rotate-90"
            />
            {m.comments_resolved({ count: resolved.length })}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="flex flex-col gap-3">{resolved.map(thread)}</ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}
