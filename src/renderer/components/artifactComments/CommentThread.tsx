import { toast } from "sonner"
import {
  type ArtifactComment,
  type CommentAnchor,
  type CommentAuthor,
  type CommentMessage,
  waitingOnDeveloper,
} from "../../../shared/artifact.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { formatRelativeTime } from "../../lib/relativeTime.ts"
import { useNow } from "../../lib/useNow.ts"
import { m } from "../../paraglide/messages.js"
import { getLocale } from "../../paraglide/runtime.js"
import { useThreads } from "../../stores/threads.ts"
import { Markdown } from "../Markdown.tsx"
import { MentionThread } from "../MentionThread.ts"
import { Badge } from "../ui/badge.tsx"
import { Button } from "../ui/button.tsx"
import { CommentInput } from "./CommentInput.tsx"
import type { FeedbackActions } from "./feedback.ts"

const scrollIntoViewOnMount = (element: HTMLElement | null) => element?.scrollIntoView({ block: "nearest" })

export function CommentThread({
  threadId,
  comment,
  actions,
  detached = false,
  focused = false,
  onShowAnchor,
}: {
  threadId: string
  comment: ArtifactComment
  actions: FeedbackActions
  detached?: boolean
  focused?: boolean
  onShowAnchor?: (comment: ArtifactComment) => void
}) {
  const waiting = waitingOnDeveloper(comment)
  const toggleResolved = async () => {
    try {
      await actions.resolve(comment.id, !comment.resolved)
    } catch (cause) {
      toast.error(m.comments_resolve_failed({ message: errorMessage(cause) }))
    }
  }
  return (
    <article
      ref={focused ? scrollIntoViewOnMount : undefined}
      aria-label={m.comments_thread({ excerpt: comment.messages[0].body.slice(0, 60) })}
      data-focused={focused || undefined}
      className="flex flex-col gap-2.5 rounded-lg border border-border p-3 transition-colors data-focused:border-ring"
    >
      <div className="flex min-h-6 items-center gap-2">
        {waiting && (
          <Badge variant="outline" className="border-attention/40 text-attention">
            {m.comments_waiting_on_you()}
          </Badge>
        )}
        <span className="flex-1" />
        <Button variant="ghost" size="xs" action={toggleResolved}>
          {comment.resolved ? m.comments_reopen() : m.comments_resolve()}
        </Button>
      </div>
      <Anchor
        anchor={comment.anchor}
        detached={detached}
        onShow={onShowAnchor === undefined ? undefined : () => onShowAnchor(comment)}
      />
      <MentionThread value={threadId}>
        <ol className="flex flex-col gap-3">
          {comment.messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
        </ol>
      </MentionThread>
      {!comment.resolved && (
        <CommentInput
          threadId={threadId}
          label={m.comments_reply()}
          placeholder={m.comments_reply()}
          onSend={(body) => actions.comment({ comment: comment.id, body })}
        />
      )}
    </article>
  )
}

function Anchor({
  anchor,
  detached,
  onShow,
}: {
  anchor: CommentAnchor
  detached: boolean
  onShow: (() => void) | undefined
}) {
  switch (anchor.kind) {
    case "artifact":
      return null
    case "elements": {
      const count = <p className="text-xs text-muted-foreground">{m.comments_elements({ count: anchor.ids.length })}</p>
      if (onShow === undefined) return count
      return (
        <button
          type="button"
          title={m.comments_show_elements()}
          onClick={onShow}
          className="rounded-sm text-start outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {count}
        </button>
      )
    }
    case "text": {
      const quote = (
        <blockquote className="line-clamp-3 border-s-2 border-attention/60 ps-2 text-start text-xs whitespace-pre-wrap text-muted-foreground">
          {anchor.quote}
        </blockquote>
      )
      if (detached)
        return (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-attention">{m.comments_detached()}</p>
            {quote}
          </div>
        )
      if (onShow === undefined) return quote
      return (
        <button
          type="button"
          title={m.comments_show_quote()}
          onClick={onShow}
          className="rounded-sm text-start outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {quote}
        </button>
      )
    }
  }
}

function AuthorName({ author }: { author: CommentAuthor }) {
  const title = useThreads((state) =>
    author.kind === "agent" && author.threadId !== undefined ? state.byId[author.threadId]?.title : undefined,
  )
  if (author.kind === "developer") return m.comments_you()
  return title ?? m.comments_agent()
}

function Message({ message }: { message: CommentMessage }) {
  const now = useNow()
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <p className="flex min-w-0 items-baseline gap-1.5 text-xs">
        <span className="truncate font-medium">
          <AuthorName author={message.author} />
        </span>
        <time dateTime={message.createdAt} className="shrink-0 text-muted-foreground">
          {formatRelativeTime(message.createdAt, now, getLocale())}
        </time>
      </p>
      <Markdown text={message.body} className="text-sm" />
    </li>
  )
}
