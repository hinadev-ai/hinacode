import { EditorState, type Extension, type Range, StateEffect, StateField } from "@codemirror/state"
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view"
import type { AgentCommand } from "../../shared/agent.ts"
import { type KnownTokens, quoteContentStart } from "../../shared/composerSyntax.ts"
import { chipIconClass, chipIconShape, commandChipClass } from "../components/CommandChip.tsx"
import { codeRuns, highlighterFor, type Loaded } from "./codeTokens.ts"
import { composerMarks } from "./composerMarks.ts"
import { iconDom } from "./iconDom.ts"

interface ComposerConfig {
  readonly commands: ReadonlyArray<AgentCommand>
  readonly files: ReadonlyArray<string>
  readonly threadIds: ReadonlyArray<string>
  readonly terminalIds: ReadonlyArray<string>
  readonly artifactIds: ReadonlyArray<string>
  readonly placeholder: string
  readonly codeTheme: string | undefined
  readonly scheme: "dark" | "light"
}

interface Config extends ComposerConfig {
  readonly known: KnownTokens
}

const withKnown = (config: ComposerConfig): Config => ({
  ...config,
  known: {
    commands: new Set(config.commands.map((command) => command.trigger + command.name)),
    files: new Set(config.files),
    threads: new Set(config.threadIds),
    terminals: new Set(config.terminalIds),
    artifacts: new Set(config.artifactIds),
  },
})

const sameConfig = (a: ComposerConfig, b: ComposerConfig) =>
  a.files === b.files &&
  a.placeholder === b.placeholder &&
  a.codeTheme === b.codeTheme &&
  a.scheme === b.scheme &&
  a.threadIds.join("\n") === b.threadIds.join("\n") &&
  a.terminalIds.join("\n") === b.terminalIds.join("\n") &&
  a.artifactIds.join("\n") === b.artifactIds.join("\n") &&
  JSON.stringify(a.commands) === JSON.stringify(b.commands)

const setConfig = StateEffect.define<ComposerConfig>()
const redraw = StateEffect.define<null>()

const configField = StateField.define<Config>({
  create: () =>
    withKnown({
      commands: [],
      files: [],
      threadIds: [],
      terminalIds: [],
      artifactIds: [],
      placeholder: "",
      codeTheme: undefined,
      scheme: "dark",
    }),
  update: (config, transaction) =>
    transaction.effects.reduce((next, effect) => (effect.is(setConfig) ? withKnown(effect.value) : next), config),
})

export function setComposerConfig(view: EditorView, config: ComposerConfig) {
  if (!sameConfig(view.state.field(configField), config)) view.dispatch({ effects: setConfig.of(config) })
}

class ChipWidget extends WidgetType {
  readonly command: AgentCommand

  constructor(command: AgentCommand) {
    super()
    this.command = command
  }

  override eq(other: ChipWidget) {
    return other.command.trigger === this.command.trigger && other.command.name === this.command.name
  }

  toDOM() {
    const chip = document.createElement("span")
    chip.className = commandChipClass
    chip.dataset["kind"] = "command"
    const icon = iconDom(chipIconShape(this.command), { "aria-hidden": "true", className: chipIconClass })
    const trigger = document.createElement("span")
    trigger.className = "sr-only"
    trigger.textContent = this.command.trigger
    chip.append(icon, trigger, this.command.label ?? this.command.name)
    return chip
  }
}

class TextWidget extends WidgetType {
  readonly className: string
  readonly text: string

  constructor(className: string, text = "") {
    super()
    this.className = className
    this.text = text
  }

  override eq(other: TextWidget) {
    return other.className === this.className && other.text === this.text
  }

  toDOM() {
    const span = document.createElement("span")
    span.className = this.className
    span.textContent = this.text
    return span
  }
}

const dot = new TextWidget("text-muted-foreground", "•")
const rule = new TextWidget("inline-block w-full border-t border-border align-middle")

const markClass = {
  code: "rounded-sm bg-muted font-mono",
  strong: "font-semibold",
  command: "text-syntax-token",
  mention: "text-syntax-token",
  marker: "text-muted-foreground",
}

const LIST_INDENT_COLUMN_EM = 0.5
const LIST_MARKER_WIDTH = "1.25em"
const listTextStart = `calc(var(--list-indent) + ${LIST_MARKER_WIDTH})`

const placeholderBefore =
  "before:pointer-events-none before:float-left before:-mb-[1lh] before:h-lh before:w-full before:truncate before:text-muted-foreground before:content-[attr(data-placeholder)]"
const placeholderAfter = "after:pointer-events-none after:text-muted-foreground after:content-[attr(data-placeholder)]"

const highlighters = new Map<string, Loaded | null>()

function build(view: EditorView) {
  const { state } = view
  const config = state.field(configField)
  const text = state.doc.toString()
  const { main } = state.selection
  const decorations: Array<Range<Decoration>> = []
  const chips: Array<Range<Decoration>> = []
  const atomic: Array<Range<Decoration>> = []
  for (const mark of composerMarks(text, config.known, config.commands, main.empty ? main.head : null)) {
    if (mark.kind === "chip") {
      const chip = Decoration.replace({ widget: new ChipWidget(mark.command) }).range(mark.from, mark.to)
      decorations.push(chip)
      chips.push(chip)
      atomic.push(chip)
    } else if (mark.kind === "dot") {
      const replaced = Decoration.replace({ widget: dot }).range(mark.from, mark.to)
      decorations.push(replaced)
      atomic.push(replaced)
    } else if (mark.kind === "hidden") {
      const hidden = Decoration.replace({}).range(mark.from, mark.to)
      decorations.push(hidden)
      atomic.push(hidden)
    } else if (mark.kind === "listItem") {
      const indent = `--list-indent: ${mark.indentColumns * LIST_INDENT_COLUMN_EM}em`
      decorations.push(Decoration.line({ class: "cm-list-line", attributes: { style: indent } }).range(mark.from))
      if (mark.markerFrom > mark.from)
        decorations.push(Decoration.mark({ class: "cm-list-indent" }).range(mark.from, mark.markerFrom))
      decorations.push(
        Decoration.mark({ class: "cm-list-marker text-muted-foreground", inclusiveStart: true }).range(
          mark.markerFrom,
          mark.to,
        ),
      )
    } else if (mark.kind === "quoteLine") {
      decorations.push(Decoration.line({ class: "cm-quote-line" }).range(mark.from))
    } else if (mark.kind === "rule") {
      decorations.push(Decoration.replace({ widget: rule }).range(mark.from, mark.to))
    } else if (mark.kind === "fenceLine") {
      const edges = [mark.first && "rounded-t-md", mark.last && "rounded-b-md"].filter(Boolean).join(" ")
      decorations.push(Decoration.line({ class: `cm-fence-line bg-muted font-mono ${edges}` }).range(mark.from))
    } else if (mark.kind === "fenceCode") {
      const key = `${config.codeTheme ?? config.scheme}\0${mark.language}`
      const highlighter = highlighters.get(key)
      if (highlighter === undefined) {
        void highlighterFor(config.codeTheme, config.scheme, mark.language).then((loaded) => {
          highlighters.set(key, loaded)
          view.dispatch({ effects: redraw.of(null) })
        })
        continue
      }
      if (highlighter === null) continue
      let offset = mark.from
      for (const run of codeRuns(highlighter, mark.code, mark.language)) {
        if (run.color && run.text !== "")
          decorations.push(
            Decoration.mark({ attributes: { style: `color: ${run.color}` } }).range(offset, offset + run.text.length),
          )
        offset += run.text.length
      }
    } else if (mark.to > mark.from)
      decorations.push(Decoration.mark({ class: markClass[mark.kind] }).range(mark.from, mark.to))
  }

  const lone = chips.length === 1 && chips[0]!.from === 0 && text.slice(chips[0]!.to) === " "
  const hint =
    text === ""
      ? config.placeholder
      : lone
        ? (config.commands.find((command) => command.trigger + command.name === text.trim())?.argumentHint ?? "")
        : ""
  if (hint !== "")
    decorations.push(
      Decoration.line({
        attributes: { "data-placeholder": hint },
        class: text === "" ? placeholderBefore : placeholderAfter,
      }).range(0),
    )
  return { decorations: Decoration.set(decorations, true), atomic: Decoration.set(atomic, true) }
}

const marksPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    atomic: DecorationSet

    constructor(view: EditorView) {
      ;({ decorations: this.decorations, atomic: this.atomic } = build(view))
    }

    update(update: ViewUpdate) {
      // FIXME: CodeMirror ends an IME composition when decorations next to its text are redrawn
      if (update.view.composing) {
        this.decorations = this.decorations.map(update.changes)
        this.atomic = this.atomic.map(update.changes)
        return
      }
      const configured = update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(setConfig) || effect.is(redraw)),
      )
      if (update.docChanged || update.selectionSet || configured)
        ({ decorations: this.decorations, atomic: this.atomic } = build(update.view))
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    eventHandlers: {
      compositionstart: (_, view) => {
        view.dom.dataset.composing = ""
      },
      compositionend: (_, view) => {
        delete view.dom.dataset.composing
        requestAnimationFrame(() => view.dispatch({ effects: redraw.of(null) }))
      },
    },
    provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
  },
)

export function atomicBefore(view: EditorView, pos: number) {
  let found: { from: number; to: number } | null = null
  view.plugin(marksPlugin)?.atomic.between(pos - 1, pos, (from, to) => {
    if (to === pos) found = { from, to }
  })
  return found as { from: number; to: number } | null
}

const caretAfterQuoteMarker = EditorState.transactionFilter.of((transaction) => {
  const { main } = transaction.newSelection
  if (!main.empty || main.head !== transaction.newDoc.lineAt(main.head).from) return transaction
  const contentStart = quoteContentStart(transaction.newDoc.toString(), main.head)
  return contentStart === null ? transaction : [transaction, { selection: { anchor: contentStart }, sequential: true }]
})

const leaveQuoteBackward = (view: EditorView) => {
  const { main } = view.state.selection
  const lineStart = view.state.doc.lineAt(main.head).from
  const atContentStart = main.empty && main.head === quoteContentStart(view.state.doc.toString(), lineStart)
  if (!atContentStart || lineStart === 0) return false
  view.dispatch({ selection: { anchor: lineStart - 1 }, scrollIntoView: true, userEvent: "select" })
  return true
}

const quoteKeys = keymap.of([
  { key: "ArrowLeft", run: leaveQuoteBackward },
  { key: "Ctrl-ArrowLeft", mac: "Alt-ArrowLeft", run: leaveQuoteBackward },
  { mac: "Ctrl-b", run: leaveQuoteBackward },
])

const layout = EditorView.theme({
  "&": { maxHeight: "15rem", minHeight: "calc(1lh + 1rem)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit", scrollbarGutter: "stable" },
  ".cm-content": {
    padding: "0.5rem 0.625rem",
    minWidth: "0",
    minHeight: "calc(1lh + 1rem)",
    caretColor: "currentColor",
  },
  ".cm-line": { padding: "0" },
  ".cm-line.cm-fence-line": { margin: "0 -0.25rem", padding: "0 0.25rem" },
  ".cm-line.cm-list-line": { paddingInlineStart: listTextStart, textIndent: `calc(-1 * ${listTextStart})` },
  ".cm-list-indent, .cm-list-marker": { display: "inline-block", textIndent: "0", whiteSpace: "pre" },
  ".cm-list-indent": { width: "var(--list-indent)" },
  ".cm-list-marker": { minWidth: LIST_MARKER_WIDTH, textAlign: "end" },
  ".cm-line.cm-quote-line": {
    borderInlineStart: "0.13em solid var(--muted-foreground)",
    paddingInlineStart: "0.75em",
  },
  "&[data-composing] [data-placeholder]::before, &[data-composing] [data-placeholder]::after": { content: "none" },
})

export const composerSyntax: Extension = [
  configField,
  marksPlugin,
  caretAfterQuoteMarker,
  quoteKeys,
  layout,
  EditorView.lineWrapping,
]
