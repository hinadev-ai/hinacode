import { Extension } from "@tiptap/core"
import type { Node } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"
import type { Run } from "../FindHighlight.tsx"
import { codeRuns, highlighterFor, type Loaded } from "../../lib/codeTokens.ts"

export type CodeTheme = { readonly codeTheme: string | undefined; readonly scheme: "dark" | "light" }

type HighlightState = { readonly theme: CodeTheme; readonly decorations: DecorationSet }

export const codeHighlightKey = new PluginKey<HighlightState>("documentCodeHighlight")

const highlighters = new Map<string, Loaded | null>()
const tokenized = new WeakMap<Node, { readonly key: string; readonly runs: ReadonlyArray<Run> }>()

const highlight = (doc: Node, theme: CodeTheme, redraw: () => void) => {
  const decorations: Array<Decoration> = []
  doc.descendants((node, position) => {
    if (node.type.name !== "codeBlock") return true
    const named = typeof node.attrs["language"] === "string" ? node.attrs["language"].toLowerCase() : ""
    const language = named === "chart" ? "json" : named
    if (language === "") return false
    const key = `${theme.codeTheme ?? theme.scheme}\0${language}`
    const highlighter = highlighters.get(key)
    if (highlighter === undefined) {
      void highlighterFor(theme.codeTheme, theme.scheme, language).then((loaded) => {
        highlighters.set(key, loaded)
        redraw()
      })
      return false
    }
    if (highlighter === null) return false
    const cached = tokenized.get(node)
    const runs = cached?.key === key ? cached.runs : codeRuns(highlighter, node.textContent, language)
    tokenized.set(node, { key, runs })
    let offset = position + 1
    for (const run of runs) {
      if (run.color !== undefined && run.text !== "")
        decorations.push(Decoration.inline(offset, offset + run.text.length, { style: `color: ${run.color}` }))
      offset += run.text.length
    }
    return false
  })
  return DecorationSet.create(doc, decorations)
}

export const CodeHighlight = Extension.create<{ theme: CodeTheme }>({
  name: "documentCodeHighlight",

  addOptions: () => ({ theme: { codeTheme: undefined, scheme: "light" } }),

  addProseMirrorPlugins() {
    let view: EditorView | null = null
    const redraw = () => {
      if (view !== null && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(codeHighlightKey, {}))
    }
    return [
      new Plugin<HighlightState>({
        key: codeHighlightKey,
        state: {
          init: (_config, { doc }) => ({
            theme: this.options.theme,
            decorations: highlight(doc, this.options.theme, redraw),
          }),
          apply: (transaction, previous) => {
            const meta: { readonly theme?: CodeTheme } | undefined = transaction.getMeta(codeHighlightKey)
            if (!transaction.docChanged && meta === undefined) return previous
            const theme = meta?.theme ?? previous.theme
            return { theme, decorations: highlight(transaction.doc, theme, redraw) }
          },
        },
        props: { decorations: (state) => codeHighlightKey.getState(state)?.decorations },
        view: (mounted) => {
          view = mounted
          return { destroy: () => (view = null) }
        },
      }),
    ]
  },
})
