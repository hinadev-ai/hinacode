# Native document editor on the phone

Status: Draft
Date: 2026-11-10

## Problem

A developer reads an agent's plan or spec on their phone and wants to fix a line before the agent acts on it. Today the phone shows a degraded, read-only view. `document-segments.ts` splits the Markdown into runs for `react-native-enriched-markdown`. Charts turn into tables, mermaid stays as source, artifact images do not load, and nothing can be edited.

Tiptap has no native runtime, and a WebView editor costs 0.9 to 9 s before it is ready and about 223 MB (`2026-11-08-native-composer-editor.md`). So the phone needs its own editor that shows the same document the desktop shows and saves the same Markdown the desktop would save.

## User flow

1. The developer opens a document card in a thread. The first screen of the document appears at once, and the rest fills in while they read.
2. They scroll a 300 KB document with a fling. Charts, tables, code and images draw natively, and no screen is blank.
3. They tap into a paragraph and type, in English, Japanese or Chinese, with the system keyboard. Autocorrect, dictation, swipe typing and paste work as in any other app.
4. A toolbar above the keyboard sets headings, lists, task lists, quotes, callouts, code blocks and table rows and columns. Selecting text shows bold, italic, strike, code and link. Tapping a task checkbox toggles it.
5. The title bar says Saving, then Saved. If the agent published while they edited, they choose Keep mine or Use theirs, as on the desktop.
6. Opening the same document on the desktop shows the same text and structure.

## Design

### One model, the desktop's own

The phone runs the desktop's model. `prosemirror-model`, `-transform`, `-state`, `-history`, `-commands`, `-schema-list` and `-tables` run on Hermes without a DOM, and so do `@tiptap/core`'s `getSchema` and `@tiptap/markdown`'s `MarkdownManager`. Only `prosemirror-view` needs a DOM, and the phone never creates one. The probe in `.context/probe/hermes-probe.ts` ran on the release Hermes VM (`hermes-ios-260318099.0.4`, macOS framework, Mac CPU).

| Measurement on Hermes                     | 2 KB    | 30 KB   | 300 KB                    |
| ----------------------------------------- | ------- | ------- | ------------------------- |
| Schema and Markdown setup                 | 8 ms    |         |                           |
| Markdown to JSON, tokenizers guarded, unchunked | 2 ms    | 32 ms   | 1200 ms                   |
| JSON to `Node`, with `check()`            | 2 ms    | 7 ms    | 64 ms                     |
| `insertText`, one character, p50 / p95    | 0.04 ms | 0.07 ms | 0.39 / 0.49 ms            |
| `toggleMark`, `splitBlock`                | 1, 2 ms | 0.3, 0.1 ms | 2, 4 ms               |
| Model to Markdown                         | 6 ms    | 18 ms   | 166 ms                    |

`undo`, `redo`, `splitListItem` and `addRowAfter` ran and gave valid documents. So the phone shares the schema, the commands and the Markdown serializer with the desktop, and behavior cannot drift between two implementations. The hand written Markdown parser from the first plan is not needed and will not be built. `prosemirror-kotlin` and a hand written native model stay unbuilt unless the typing prototype (below) shows the JS model is too slow.

The schema moves to shared code. `src/shared/documentSchema.ts` holds the extension list both apps use: StarterKit with the same options, the callout and the callout-aware blockquote, the code block, task list and item, tables and image, each with its Markdown parse and render rules and without node views. The desktop adds its node views with `.extend({ addNodeView })`. Nothing else in the tree is new: the render tree, the edit model and the saved file all come from one ProseMirror `Node`.

ProseMirror already holds every rule the editor needs: flat positions in UTF-16 units, merged text runs with no empty text, mark ranks and `excludes`, content expressions checked by `check()`, `storedMarks`, text, node and all selections, and steps that map and invert. The phone does not re-implement any of them.

Illegal trees are unrepresentable through the schema. `Node.fromJSON` and `check()` reject what the content expressions forbid. Content the parser cannot place becomes the `unsupported` fallback, a block node with a `source` attribute. It shows its source as text and saves it back verbatim, so it never blanks the document or loses text. The desktop gets the same node, so a tree the desktop rejects is never stored.

### Parsing fast enough on Hermes

The stock parse is quadratic, for three reasons we found and fixed in the probe.

1. `@tiptap/extension-list`'s task list tokenizer calls `parseIndentedBlocks`, which splits the whole remaining source into lines at every block before it checks the first line. A guard that tests the first non-blank line first gives the same tokens. In Node, 300 KB went from 1150 ms to 200 ms.
2. `@tiptap/extension-table`'s `start` splits the whole remaining source to read two lines. Reading only two lines gives the same tokens and takes 300 KB down to 85 ms in Node. Upstream already tracks both as ueberdosis/tiptap#8458, with the fix in #8467. `patches/@tiptap__core@3.32.2.patch` and `patches/@tiptap__extension-table@3.32.2.patch` apply that fix here, so the desktop gets it too. Drop them once a release carries it.
3. Hermes copies on `substring`, where V8 shares the buffer. `marked` cuts `src.substring(raw.length)` after every token, so plain `marked` is quadratic on Hermes (271 ms at 120 KB, 953 ms at 240 KB). The fix is to lex in chunks. The source splits at top-level block boundaries (a blank line outside a fence, followed by a line that cannot continue a list, quote or table), and each chunk is parsed alone. Reference-style link definitions are document-wide, so they are collected first and appended to every chunk that uses one.

The probe in `.context/probe/hermes-chunk.ts` lexes an 8 KB window, keeps every top-level token but the last, and checks each kept token's `raw` against the source before it cuts. It cuts only where exactly one blank line separates two blocks, because Tiptap turns extra blank lines into empty paragraphs. On the three generated documents the chunked tree equals the whole tree. On Hermes the 300 KB document parses in 470 ms instead of 1220 ms, and the first chunk is ready in under 10 ms. The probe lexes twice, once to cut and once inside `parse`. Handing the kept tokens straight to `MarkdownManager`'s token parser removes the second pass.

Chunks also give the first screen early and make updates cheap (see Live updates). The conformance test checks that chunked parsing equals whole-document parsing on the desktop for every fixture.

`MarkdownManager` falls back to the global `marked` instance when none is passed, and every manager then stacks its tokenizers onto it. Both apps pass their own `new Marked()`.

### Raw HTML

Without `window.DOMParser`, `@tiptap/markdown` keeps raw HTML as literal text. The desktop converts the tags its schema knows (for example `<em>`, `<br>`). Left alone, the same file would parse into different trees on the two apps, and a phone save could rewrite HTML the desktop had turned into marks. Checkpoint 3 settles this by measurement: a small DOM parser shim on Hermes (`linkedom` or `htmlparser2` with a `DOMParser` facade) if it costs under 50 KB of bytecode and passes the HTML fixtures, otherwise literal HTML on both apps. Either way both apps run one rule.

### Rendering by block

The native view never sees ProseMirror. JS turns the document into a flat list of render blocks, and native code draws them in a recycled list: `UICollectionView` with one TextKit 2 text view per text block on iOS, `RecyclerView` with one `TextView` per block on Android. A whole document never sits in one text view, because TextKit 2 cannot lay out tables and estimates the height of long documents.

```ts
type BlockId = string

type Run = {
  readonly text: string
  readonly marks: ReadonlyArray<"bold" | "italic" | "strike" | "code">
  readonly href?: string
}

type Inline = Run | { readonly kind: "hardBreak" }

type Container =
  | { readonly kind: "bullet"; readonly depth: number }
  | { readonly kind: "ordered"; readonly depth: number; readonly number: number }
  | { readonly kind: "task"; readonly depth: number; readonly checked: boolean }
  | { readonly kind: "quote" }
  | { readonly kind: "callout"; readonly tone: CalloutTone; readonly first: boolean; readonly last: boolean }

type RenderBlock = {
  readonly id: BlockId
  readonly from: number
  readonly containers: ReadonlyArray<Container>
} & (
  | { readonly kind: "paragraph"; readonly inline: ReadonlyArray<Inline> }
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly inline: ReadonlyArray<Inline> }
  | { readonly kind: "code"; readonly language: string; readonly text: string }
  | { readonly kind: "chart"; readonly chart: Chart }
  | { readonly kind: "diagram"; readonly source: string }
  | { readonly kind: "table"; readonly rows: ReadonlyArray<ReadonlyArray<TableCell>> }
  | { readonly kind: "image"; readonly src: string; readonly alt: string }
  | { readonly kind: "rule" }
  | { readonly kind: "unsupported"; readonly source: string }
)
```

Lists, task lists, quotes and callouts are flattened. Each text block inside them carries the containers it sits in, outermost first, and native code draws the bullets, numbers, checkboxes, quote bars and callout bands from that path. Flattening keeps every row recyclable and keeps the list's cost to the visible rows. `from` is the block's ProseMirror position, which maps a native caret to a model position by adding a UTF-16 offset.

Block ids come from node identity. ProseMirror shares unchanged nodes between documents, so a `WeakMap<Node, BlockId>` gives an unchanged block the same id after any transaction, and a changed block a new one. Finding what changed is a pointer comparison per top-level node.

Charts draw natively from `ChartSpec` with theme colors. Code highlights in JS with the desktop's highlighter, sent as color runs per block, only for blocks on screen. Mermaid is decided at checkpoint 5: if `MermaidDiagram.tsx`'s renderer cannot produce drawable output on Hermes, the block shows its source under a Diagram label, and that is reported as a known gap. Images under `images/<name>` load through `artifacts.file`. Links open only http(s), per `src/shared/documentLink.ts`.

### Editing

The native text view of the focused block owns its text while the user types. It reports text diffs and selection changes, and JS applies them to the model as transactions. Typed characters therefore show up without waiting for JS. The model's cost shows up as CPU and as the delay before a structural edit (Enter, a toolbar command) redraws.

- No model change is pushed into a text view that has marked text. Input rules, normalization and mark changes wait until the composition commits. This is the same rule `packages/composer-editor` keeps, and it covers tiptap #5733 and #8626.
- Stale patches cannot undo typing. Every native edit raises the view's event count, and each patch JS sends down names the count it was computed from. The view drops a patch for its focused block that is older than its latest edit. The scheme and its reason are the composer's ("Stale renders cannot undo typing").
- Input arrives as replacements, not keys. Paste, autocorrect, dictation, swipe typing and GBoard's whole-word replacement (#5911, #7174) all reach JS as `{ from, to, text }` over the block's text, computed from the text before and after.
- Marks at boundaries are explicit. Typing after a mark change uses `storedMarks`, and links are not inclusive (#2571, #5849), as on the desktop.
- Enter, Backspace at the start of a block and Tab in a list are commands on the model, never text edits. The view intercepts them and calls `splitListItem`, `liftListItem`, `sinkListItem`, `joinBackward` and the rest, the same functions the desktop's keymap calls. Nested list backspace and task item edges (#2493, #3367, #4268) get one command test each, written first, with the desktop's result as the expected tree.

Selection that spans blocks is the risk in a view-per-block design. Checkpoint 8 prototypes it on both platforms before the editing slice: a drag that starts in one block extends a selection drawn by our own overlay across blocks, with the system handles inside one block. If it cannot be made to feel native, the alternative is one text view per run of contiguous text blocks, with tables, charts and images as separate views, and the recording goes into this doc.

### Saving

The saved format stays Markdown. The pure part of `documentSync.ts` (revisions, edit counts, the 500 ms debounce, conflict, Keep mine, Use theirs, catching up on `artifact.updated` only when clean) moves to `src/shared/documentSync.ts`, parameterized by `getMarkdown` and an rpc caller. Both apps run that one implementation. Serializing happens on the save debounce only and is measured. Opening a document never saves it. Only an edit makes it dirty.

### Live updates

A push of `artifact.updated` for a clean document re-reads it. The new Markdown is split into chunks, chunks with the same text as before reuse their parsed nodes, and only changed chunks are parsed. The new document is diffed against the shown one by top-level node, and native code gets a patch for the changed blocks only. Cost follows the size of the change, apart from one linear string comparison.

### The bridge: `DocumentEditor`

`packages/document-view` is an Expo module with the same layout as `packages/composer-editor`. It exports one component, `DocumentEditor`, and its types. `document.tsx` uses nothing else, and no screen calls the native module directly. The contract is written first, in `packages/document-view/src/types.ts`, and the JS half decodes everything that crosses the bridge with Effect Schema.

```ts
type Result<E extends string = string> = { readonly ok: true } | { readonly ok: false; readonly reason: E }

type BlockType =
  | { readonly type: "paragraph" }
  | { readonly type: "heading"; readonly level: 1 | 2 | 3 }
  | { readonly type: "codeBlock"; readonly language: string }
  | { readonly type: "callout"; readonly tone: CalloutTone }
  | { readonly type: "blockquote" }

type MarkName = "bold" | "italic" | "strike" | "code" | "link"

type EditorSelection =
  | { readonly type: "text"; readonly anchor: number; readonly head: number }
  | { readonly type: "node"; readonly at: number }
  | { readonly type: "all" }

type SelectionChange = {
  readonly selection: EditorSelection
  readonly marks: ReadonlyArray<MarkName>
  readonly block: BlockType["type"] | "listItem" | "taskItem" | "tableCell" | "chart" | "diagram" | "image"
  readonly can: Readonly<Record<DocumentCommand, boolean>>
}

type DocumentEditorProps = {
  readonly document: DocumentContent
  readonly editable: boolean
  readonly theme: DocumentTheme
  readonly resolveImage: (path: `images/${string}`) => Promise<string>
  readonly highlights?: ReadonlyArray<{ readonly id: string; readonly from: number; readonly to: number }>
  readonly contentInset?: { readonly top: number; readonly bottom: number }
  readonly onChange?: (change: { readonly edits: number; readonly blocks: ReadonlyArray<BlockId> }) => void
  readonly onSelectionChange?: (change: SelectionChange) => void
  readonly onFocus?: () => void
  readonly onBlur?: () => void
  readonly onLinkPress?: (href: string) => void
  readonly onContentSizeChange?: (size: { readonly height: number }) => void
  readonly onError?: (error: { readonly kind: "unsupported" | "image"; readonly message: string; readonly at?: number }) => void
  readonly onReady?: (ready: { readonly capabilities: ReadonlyArray<Capability> }) => void
}

type DocumentEditorHandle = {
  focus(at?: number): Promise<Result>
  blur(): Promise<Result>
  run(command: DocumentCommand, args?: CommandArgs): Promise<Result<"not-applicable" | "unsupported">>
  undo(): Promise<Result<"empty">>
  redo(): Promise<Result<"empty">>
  getMarkdown(): Promise<string>
  scrollTo(at: number): Promise<Result>
}
```

`DocumentCommand` is one list, `toggleBold` through `deleteTableColumn`, with `insertImage` and `setLink` taking arguments. `onChange` says which blocks changed and how many edits there have been, never the document. The screen saves through the shared sync with `getMarkdown`. A command that cannot run returns a reason and never throws across the bridge. A capability one platform lacks is missing from `onReady`'s list, and its command returns `unsupported`.

The props and the handle are the same wherever the model lives. What crosses the bridge differs.

| Model in JS (chosen, pending the typing prototype)                                                     | Model in native code (fallback)                                    |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Down, on open: render blocks for the first screen, then the rest in chunks                             | Down, on open: the parsed tree as JSON, once                       |
| Up, per keystroke: `{ block, eventCount, from, to, text, selection }`, about 100 bytes                  | Up, per keystroke: `{ blocks changed, edits }`                     |
| Down, per keystroke: nothing, unless the model changed the text the view shows                         | Down, per keystroke: nothing                                       |
| Down, per structural edit or update: a patch `{ eventCount, remove, insert: RenderBlock[] }` per range | Down, per command: the command name and args                       |
| Commands run in JS on the model                                                                        | Commands run in native code                                        |
| `getMarkdown` serializes in JS                                                                         | `getMarkdown` asks native for JSON, then serializes in JS          |

The budget for the chosen shape: under 1 KB and 1 ms of bridge time per typed character, and a patch proportional to the changed blocks for a structural edit or an `artifact.updated`. Patches go down as one view function call carrying JSON. A synchronous or shared-object path is used only if the measurement shows the async one is too slow.

The names of commands, events and capabilities live in one file, `packages/document-view/src/protocol.ts`. A generator writes `ios/Protocol.swift` and `android/.../Protocol.kt` from it, and a test fails when the generated files are stale, so a platform cannot miss a case. A web file (`DocumentEditor.web.tsx`) renders the document read-only so the Expo web build compiles.

```tsx
const editor = useRef<DocumentEditorHandle>(null)
const sync = useDocumentSync({ id, loaded, getMarkdown: () => editor.current!.getMarkdown() })

<DocumentEditor
  ref={editor}
  document={sync.document}
  editable={connected}
  theme={documentTheme(scheme)}
  resolveImage={(path) => call("artifacts.file", { id, path }).then(({ dataUrl }) => dataUrl)}
  contentInset={{ top: 0, bottom: keyboardHeight + TOOLBAR_HEIGHT }}
  onChange={sync.edited}
  onSelectionChange={setToolbarState}
  onLinkPress={openHttpLink}
/>
```

## Out of scope

Collaboration and creating comments. Comment highlights get a prop so they can be drawn later. Input rules (`## ` to a heading) wait until after the toolbar ships, and they run only after a composition commits.

## Verification

- Conformance in `pnpm test`. For every fixture in `src/shared/documentFixtures/`, Markdown to tree equals the desktop editor's `getJSON()`, tree to Markdown equals its `getMarkdown()`, and chunked parsing equals whole parsing. Command cases apply the same commands on a desktop `Editor` and on the shared model and compare trees. The desktop side runs in the existing Chromium component test runner.
- The fixtures cover every node and mark, deep nesting, the `@tiptap/markdown` round trip gaps (#8136, #8478, #8341, #8182, #8472, #8286, #8637), CJK, RTL, emoji and surrogate pairs, long unbroken strings, wide tables, an invalid chart, an unknown fence language, raw HTML, an empty document and a 300 KB document.
- A property test feeds random strings and random Markdown fragments to the parser. It never throws and always yields a document that passes `check()`.
- Native, per block type, screenshots from the iOS simulator and the Android emulator next to the desktop rendering of the same fixture. A tree with an unknown node renders the fallback block.
- Editing, on both platforms: Japanese and Chinese with the system IME in a paragraph, a heading, a list item and a table cell, with and without an active mark. Paste of multiple paragraphs, an autocorrected word, undo and redo across a structural edit. Then the same document on the desktop shows the same Markdown. Short recordings go in the PRs.
- Performance through `scripts/perf/mobile.ts`'s document workload, against the baseline below. Simulator and emulator numbers are relative, not what a phone measures.

## Measurements

The baseline is the current screen (`document-segments.ts` and `react-native-enriched-markdown`), Release builds with the perf harness, at `cc4adf6d`. iOS ran on an iPhone 17 Pro Max simulator (iOS 27.0), and Android on an API 36 arm64 emulator, both on one Apple silicon Mac mini. Each value is a median over 3 runs, with 9 samples per open and 3 per large-document pass. The one-minute load average stayed between 2.9 and 9. These are relative numbers. A simulator runs on the Mac's CPU, and an emulator adds its own overhead.

| Measurement                                  | iOS before        | iOS after | Android before     | Android after |
| -------------------------------------------- | ----------------- | --------- | ------------------ | ------------- |
| Open small (2 KB), first content             | 89 ms             |           | 81 ms              |               |
| Open medium (30 KB), first content           | 92 ms             |           | 89 ms              |               |
| Open large (300 KB), first content           | 180 ms            |           | 745 ms             |               |
| Open, interactive (S / M / L)                | 700 / 776 / 759 ms |          | 315 / 493 / 746 ms |               |
| Parse in JS (S / M / L)                      | 1 / 14 / 106 ms   |           | 1 / 13 / 230 ms    |               |
| Handoff to native                            | not separable     |           | not separable      |               |
| Longest commit opening large                 | 90 ms             |           | 405 ms             |               |
| Memory after opening large                   | 356 MB footprint  |           | 259 MB PSS         |               |
| Fling through large, native frame p95 / max  | 16.7 / 38.9 ms    |           | 33.3 / 66.7 ms     |               |
| Fling, native frames over 32 ms              | 6                 |           | 55                 |               |
| Fling, `gfxinfo` janky frames / p99          | not available     |           | 72 / 73 ms         |               |
| One paragraph changed by `artifact.updated`  | 203 ms            |           | 494 ms             |               |

How to read it:

- First content is the frame after the first commit that holds the document list, timed from JS. It does not see enriched-markdown's native layout after the commit.
- On iOS, interactive is dominated by the push transition. Its last commits are the screen freeze at about 670 ms and the list layout at about 735 ms, so all three sizes land near 700 to 800 ms.
- On Android, the large document arrives in one 400 to 550 ms commit after a 230 ms parse, so first content and interactive are the same. The JS thread's p95 frame during the fling is 104 ms.
- The old path has no separate handoff. Enriched-markdown parses Markdown again natively inside its view.
- Native frame gaps come from `CADisplayLink` and `Choreographer` (`packages/perf-frames`). They show main-thread stalls and miss render-thread and GPU work. Xcode's Hitches and Core Animation FPS instruments do not support the simulator.
- Every open also re-renders the hidden home list behind the document: 85 thread rows and about 1,100 link previews, about 6,600 component renders per open on iOS. That is a separate bug. It gets fixed on its own, and the after column is measured with the fix on both sides.
