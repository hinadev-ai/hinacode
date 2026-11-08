import { Popover } from "@base-ui/react/popover"
import { ArrowLeftIcon, CloseIcon } from "@hinacode/icons"
import { type Editor, posToDOMRect } from "@tiptap/core"
import { AsyncResult } from "effect/reactivity"
import { useRef } from "react"
import type { ArtifactComment, ArtifactFeedback } from "../../../shared/artifact.ts"
import { resolveTextAnchor, type TextAnchor, type TextRange, textAnchorAt } from "../../../shared/textAnchor.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { m } from "../../paraglide/messages.js"
import { CommentInput } from "../artifactComments/CommentInput.tsx"
import { CommentList } from "../artifactComments/CommentList.tsx"
import type { FeedbackActions } from "../artifactComments/feedback.ts"
import { Button } from "../ui/button.tsx"
import { ScrollArea } from "../ui/scroll-area.tsx"
import { type CommentHighlight, type CommentHighlightMeta, commentHighlightKey } from "./commentHighlight.ts"
import { popupSurface } from "./DocumentLinks.tsx"
import { documentText } from "./documentText.ts"

export type CommentDraft = { readonly range: TextRange; readonly anchor: TextAnchor }

const showPending = (editor: Editor, pending: TextRange | null) =>
  editor.view.dispatch(editor.state.tr.setMeta(commentHighlightKey, { pending } satisfies CommentHighlightMeta))

export const showHighlights = (editor: Editor, highlights: ReadonlyArray<CommentHighlight>) =>
  editor.view.dispatch(editor.state.tr.setMeta(commentHighlightKey, { highlights } satisfies CommentHighlightMeta))

export const highlightsOf = (feedback: ArtifactFeedback): ReadonlyArray<CommentHighlight> =>
  feedback.comments.flatMap((comment) =>
    !comment.resolved && comment.anchor.kind === "text" ? [{ id: comment.id, anchor: comment.anchor }] : [],
  )

export const draftAtSelection = (editor: Editor): CommentDraft | null => {
  const { from, to } = editor.state.selection
  const text = documentText(editor.state.doc)
  const range = text.textRange({ from, to })
  const anchor = textAnchorAt(text.text, range.from, range.to)
  if (anchor.quote.trim() === "") return null
  showPending(editor, { from, to })
  return { range: { from, to }, anchor }
}

export const discardDraft = (editor: Editor) => showPending(editor, null)

export const selectQuote = (editor: Editor, comment: ArtifactComment) => {
  if (comment.anchor.kind !== "text") return
  const text = documentText(editor.state.doc)
  const found = resolveTextAnchor(text.text, comment.anchor)
  if (found === null) return
  editor.chain().focus().setTextSelection(text.documentRange(found)).scrollIntoView().run()
}

export function CommentComposer({
  editor,
  threadId,
  draft,
  onSend,
  onClose,
}: {
  editor: Editor
  threadId: string
  draft: CommentDraft | null
  onSend: (draft: CommentDraft, body: string) => Promise<void>
  onClose: () => void
}) {
  const input = useRef<HTMLTextAreaElement>(null)
  return (
    <Popover.Root
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={
            draft === null
              ? null
              : {
                  contextElement: editor.view.dom,
                  getBoundingClientRect: () => posToDOMRect(editor.view, draft.range.from, draft.range.to),
                }
          }
          side="bottom"
          align="start"
          sideOffset={6}
          className="isolate z-50"
        >
          <Popover.Popup
            aria-label={m.comments_new()}
            initialFocus={input}
            finalFocus={() => editor.view.dom}
            className={`${popupSurface} w-80 max-w-[calc(100vw-2rem)] p-2`}
          >
            {draft !== null && (
              <CommentInput
                key={`${draft.range.from}:${draft.range.to}`}
                threadId={threadId}
                label={m.comments_new()}
                placeholder={m.comments_new_placeholder()}
                inputRef={input}
                onSend={(body) => onSend(draft, body)}
              />
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

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
