import { Popover } from "@base-ui/react/popover"
import { type Editor, posToDOMRect } from "@tiptap/core"
import { useRef } from "react"
import type { ArtifactComment, ArtifactFeedback } from "../../../shared/artifact.ts"
import { resolveTextAnchor, type TextAnchor, type TextRange, textAnchorAt } from "../../../shared/textAnchor.ts"
import { m } from "../../paraglide/messages.js"
import { CommentInput } from "../artifactComments/CommentInput.tsx"
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
