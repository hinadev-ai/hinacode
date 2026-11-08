import { ArrowLeftIcon, CloseIcon } from "@hinacode/icons"
import { AsyncResult } from "effect/reactivity"
import type { ArtifactComment, ArtifactFeedback } from "../../../shared/artifact.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"
import { ScrollArea } from "../ui/scroll-area.tsx"
import { CommentList } from "./CommentList.tsx"
import type { FeedbackActions } from "./feedback.ts"

export function CommentsPane({
  threadId,
  feedback,
  actions,
  detached,
  focused,
  onShowAnchor,
  onClose,
}: {
  threadId: string
  feedback: AsyncResult.AsyncResult<ArtifactFeedback, unknown>
  actions: FeedbackActions
  detached: ReadonlySet<string>
  focused: string | null
  onShowAnchor: (comment: ArtifactComment) => void
  onClose: () => void
}) {
  return (
    <section
      aria-label={m.comments_title()}
      className="flex min-h-0 min-w-0 flex-col border-border @max-2xl:flex-1 @2xl:w-80 @2xl:shrink-0 @2xl:border-s"
    >
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <Button
          variant="ghost"
          size="icon-sm"
          className="@2xl:hidden"
          aria-label={m.comments_back()}
          title={m.comments_back()}
          action={onClose}
        >
          <ArrowLeftIcon aria-hidden />
        </Button>
        <h3 className="min-w-0 flex-1 truncate ps-1 text-xs font-medium">{m.comments_title()}</h3>
        <Button
          variant="ghost"
          size="icon-sm"
          className="@max-2xl:hidden"
          aria-label={m.comments_close()}
          title={m.comments_close()}
          action={onClose}
        >
          <CloseIcon aria-hidden />
        </Button>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        {AsyncResult.builder(feedback)
          .onInitial(() => null)
          .onSuccess((loaded) => (
            <CommentList
              threadId={threadId}
              comments={loaded.comments}
              actions={actions}
              detached={detached}
              focused={focused}
              onShowAnchor={onShowAnchor}
            />
          ))
          .onError((error) => (
            <p role="alert" className="p-3 text-xs wrap-anywhere text-destructive">
              {m.comments_load_failed({ message: errorMessage(error) })}
            </p>
          ))
          .orElse(() => null)}
      </ScrollArea>
    </section>
  )
}
