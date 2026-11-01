import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState, useTransition } from "react"
import { errorMessage } from "../lib/errorMessage.ts"
import { lineRange } from "../lib/lineComments.ts"
import { m } from "../paraglide/messages.js"
import type { LineComment } from "../stores/drafts.ts"
import { Button } from "./ui/button.tsx"
import { Textarea } from "./ui/textarea.tsx"
import { ChatIcon } from "./icons/ChatIcon.tsx"
import { CloseIcon } from "./icons/CloseIcon.tsx"
import { PencilIcon } from "./icons/PencilIcon.tsx"
import { TrashIcon } from "./icons/TrashIcon.tsx"

const location = (comment: Pick<LineComment, "path" | "startLine" | "endLine">) =>
  `${comment.path}:${lineRange(comment)}`

interface LineCommentFormProps {
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly initialBody?: string
  readonly submitLabel?: string
  readonly placeholder?: string
  readonly onSubmit: (body: string) => void | Promise<void>
  readonly alternate?: { readonly label: string; readonly onSubmit: (body: string) => Promise<void> }
  readonly onCancel: () => void
}

export function LineCommentForm({
  path,
  startLine,
  endLine,
  initialBody = "",
  submitLabel = initialBody === "" ? m.comment_add() : m.comment_update(),
  placeholder = m.comment_placeholder(),
  onSubmit,
  alternate,
  onCancel,
}: LineCommentFormProps) {
  const [body, setBody] = useState(initialBody)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const canSubmit = body.trim() !== "" && !pending

  // FIXME: @pierre/diffs lays out annotations after React mounts them, and focus only sticks once the box has a size
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const observer = new ResizeObserver(() => {
      textarea.focus()
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
      observer.disconnect()
    })
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [])

  const send = (submitBody: (body: string) => void | Promise<void>) =>
    startTransition(async () => {
      setError(null)
      try {
        await submitBody(body.trim())
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (canSubmit) send(onSubmit)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation()
    if (event.key === "Escape") onCancel()
    else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event)
  }

  return (
    <form
      onSubmit={submit}
      className="m-2 flex max-w-xl flex-col gap-2 rounded-[17px] border border-border bg-background p-2 font-sans"
    >
      <Textarea
        ref={textareaRef}
        aria-label={m.comment_label({ location: location({ path, startLine, endLine }) })}
        placeholder={placeholder}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        className="min-h-14 rounded-md text-xs"
      />
      {error && (
        <p role="alert" className="px-1 text-xs wrap-anywhere text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-1">
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          {m.comment_cancel()}
        </Button>
        {alternate && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={!canSubmit}
            onClick={() => send(alternate.onSubmit)}
          >
            {alternate.label}
          </Button>
        )}
        <Button type="submit" size="xs" disabled={!canSubmit} title={m.comment_submit_hint()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

export function LineCommentCard({
  comment,
  onEdit,
  onDelete,
}: {
  comment: LineComment
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <article
      aria-label={m.comment_label({ location: location(comment) })}
      className="m-2 flex max-w-xl items-start gap-2 rounded-lg border border-border bg-background py-1.5 pr-1.5 pl-2.5 font-sans text-xs"
    >
      <ChatIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 py-0.5 wrap-break-word whitespace-pre-wrap">{comment.body}</p>
      <Button variant="ghost" size="icon-xs" aria-label={m.comment_edit()} title={m.comment_edit()} onClick={onEdit}>
        <PencilIcon aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={m.comment_delete()}
        title={m.comment_delete()}
        onClick={onDelete}
      >
        <TrashIcon aria-hidden />
      </Button>
    </article>
  )
}

export function PendingLineComment({ comment, onRemove }: { comment: LineComment; onRemove: () => void }) {
  return (
    <div className="relative">
      <span
        title={comment.body}
        className="flex h-16 w-56 flex-col justify-center gap-0.5 rounded-lg border border-border bg-background/50 px-3 text-left text-xs"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <ChatIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono font-medium">{location(comment)}</span>
        </span>
        <span className="truncate text-muted-foreground">{comment.body}</span>
      </span>
      <Button
        type="button"
        size="icon-xs"
        variant="secondary"
        onClick={onRemove}
        aria-label={m.comment_remove({ location: location(comment) })}
        className="absolute -top-1.5 -right-1.5 rounded-full border border-border"
      >
        <CloseIcon aria-hidden />
      </Button>
    </div>
  )
}
