import { Extension } from "@tiptap/core"
import type { Node } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { resolveTextAnchor, type TextAnchor, type TextRange } from "../../../shared/textAnchor.ts"
import { documentText } from "./documentText.ts"

export type CommentHighlight = { readonly id: string; readonly anchor: TextAnchor }

type HighlightState = {
  readonly highlights: ReadonlyArray<CommentHighlight>
  readonly pending: TextRange | null
  readonly detached: ReadonlyArray<string>
  readonly decorations: DecorationSet
}

export type CommentHighlightMeta = {
  readonly highlights?: ReadonlyArray<CommentHighlight>
  readonly pending?: TextRange | null
}

export const commentHighlightKey = new PluginKey<HighlightState>("documentComments")

const highlight = (
  doc: Node,
  highlights: ReadonlyArray<CommentHighlight>,
  pending: TextRange | null,
): HighlightState => {
  const text = documentText(doc)
  const decorations: Array<Decoration> = []
  const detached: Array<string> = []
  for (const { id, anchor } of highlights) {
    const found = resolveTextAnchor(text.text, anchor)
    if (found === null) {
      detached.push(id)
      continue
    }
    const { from, to } = text.documentRange(found)
    if (from < to) decorations.push(Decoration.inline(from, to, { class: "hina-comment" }, { commentId: id }))
  }
  if (pending !== null && pending.from < pending.to)
    decorations.push(Decoration.inline(pending.from, pending.to, { class: "hina-comment hina-comment-pending" }))
  return { highlights, pending, detached, decorations: DecorationSet.create(doc, decorations) }
}

export const commentDetachedIds = (state: Parameters<typeof commentHighlightKey.getState>[0]) =>
  commentHighlightKey.getState(state)?.detached ?? []

export const CommentHighlights = Extension.create<{ onOpen: (commentId: string) => void }>({
  name: "documentComments",

  addOptions: () => ({ onOpen: () => {} }),

  addProseMirrorPlugins() {
    const { onOpen } = this.options
    return [
      new Plugin<HighlightState>({
        key: commentHighlightKey,
        state: {
          init: (_config, { doc }) => highlight(doc, [], null),
          apply: (transaction, previous) => {
            const meta: CommentHighlightMeta | undefined = transaction.getMeta(commentHighlightKey)
            if (!transaction.docChanged && meta === undefined) return previous
            const mappedPending =
              previous.pending === null
                ? null
                : {
                    from: transaction.mapping.map(previous.pending.from),
                    to: transaction.mapping.map(previous.pending.to),
                  }
            return highlight(
              transaction.doc,
              meta?.highlights ?? previous.highlights,
              meta?.pending === undefined ? mappedPending : meta.pending,
            )
          },
        },
        props: {
          decorations: (state) => commentHighlightKey.getState(state)?.decorations,
          handleClick: (view, position) => {
            const found = commentHighlightKey
              .getState(view.state)
              ?.decorations.find(position, position, (spec) => typeof spec["commentId"] === "string")
            const commentId = found?.[0]?.spec["commentId"]
            if (typeof commentId === "string") onOpen(commentId)
            return false
          },
        },
      }),
    ]
  },
})
