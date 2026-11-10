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

| Measurement on Hermes                           | 2 KB    | 30 KB       | 300 KB         |
| ----------------------------------------------- | ------- | ----------- | -------------- |
| Schema and Markdown setup                       | 8 ms    |             |                |
| Markdown to JSON, tokenizers guarded, unchunked | 2 ms    | 32 ms       | 1200 ms        |
| JSON to `Node`, with `check()`                  | 2 ms    | 7 ms        | 64 ms          |
| `insertText`, one character, p50 / p95          | 0.04 ms | 0.07 ms     | 0.39 / 0.49 ms |
| `toggleMark`, `splitBlock`                      | 1, 2 ms | 0.3, 0.1 ms | 2, 4 ms        |
| Model to Markdown                               | 6 ms    | 18 ms       | 166 ms         |

`undo`, `redo`, `splitListItem` and `addRowAfter` ran and gave valid documents. So the phone shares the schema, the commands and the Markdown serializer with the desktop, and behavior cannot drift between two implementations. The hand written Markdown parser from the first plan is not needed and will not be built. `prosemirror-kotlin` and a hand written native model stay unbuilt unless the typing prototype (below) shows the JS model is too slow.

The schema moves to shared code. `src/shared/documentSchema.ts` holds the extension list both apps use: StarterKit with the same options, the callout and the callout-aware blockquote, the code block, task list and item, tables and image, each with its Markdown parse and render rules and without node views. The desktop adds its node views with `.extend({ addNodeView })`. Nothing else in the tree is new: the render tree, the edit model and the saved file all come from one ProseMirror `Node`.

ProseMirror already holds every rule the editor needs: flat positions in UTF-16 units, merged text runs with no empty text, mark ranks and `excludes`, content expressions checked by `check()`, `storedMarks`, text, node and all selections, and steps that map and invert. The phone does not re-implement any of them.

The phone holds exactly the tree the desktop holds, invalid parts included. Tiptap loads Markdown without `check()`, so the desktop keeps and edits trees its own content expressions forbid: bold or a link over code, an image inside a paragraph, an empty quote. Repairing them on the phone would make a phone save rewrite the file, so the phone keeps them too, and the native renderer draws any combination of marks and any block where it sits. The conformance test pins both apps to the same tree.

`parseDocument` never throws. A run of blocks the parser cannot place becomes plain paragraphs of its source, and the result says `lossy: true`. A lossy document opens read-only, because saving it would rewrite the source. No fixture and no generated input has produced one.

### Parsing fast enough on Hermes

The stock parse is quadratic, for three reasons we found and fixed in the probe.

1. `@tiptap/extension-list`'s task list tokenizer calls `parseIndentedBlocks`, which splits the whole remaining source into lines at every block before it checks the first line. A guard that tests the first non-blank line first gives the same tokens. In Node, 300 KB went from 1150 ms to 200 ms.
2. `@tiptap/extension-table`'s `start` splits the whole remaining source to read two lines. Reading only two lines gives the same tokens and takes 300 KB down to 85 ms in Node. Upstream already tracks both as ueberdosis/tiptap#8458, with the fix in #8467. `patches/@tiptap__core@3.32.2.patch` and `patches/@tiptap__extension-table@3.32.2.patch` apply that fix here, so the desktop gets it too. Drop them once a release carries it.
3. Hermes copies on `substring`, where V8 shares the buffer. `marked` cuts `src.substring(raw.length)` after every token, so plain `marked` is quadratic on Hermes (271 ms at 120 KB, 953 ms at 240 KB). So `src/shared/document/parse.ts` lexes in chunks.

`documentChunks` lexes an 8 KB window and cuts at the latest top-level boundary inside it where exactly one blank line separates two blocks, because Tiptap turns extra blank lines into empty paragraphs. Every token before the cut is checked against the source, and when no clean boundary exists the window doubles. Tiptap folds blank lines into a neighboring block's `raw` (a task list takes the ones before it, a list the ones after), so the cutter trims the last kept block's trailing newlines, as lexing that chunk alone would. Each chunk is lexed once, and its tokens go straight to `MarkdownManager.parseTokens`. A document with reference-style link definitions is parsed whole, since a definition applies to the whole document.

| `parseDocument` on Hermes, Mac CPU | 2 KB | 30 KB | 300 KB |
| ---------------------------------- | ---- | ----- | ------ |
| Parse                              | 2 ms | 30 ms | 300 ms |
| Serialize                          | 5 ms | 17 ms | 186 ms |

Chunks also give the first screen early and make updates cheap (see Live updates). The conformance test checks that the chunked 300 KB document and a document made of every fixture equal the desktop's whole parse, and a property test checks the same on generated documents.

`MarkdownManager` falls back to the global `marked` instance when none is passed, and every manager then stacks its tokenizers onto it. Both apps pass their own `new Marked()`.

### Raw HTML

Without `window.DOMParser`, `@tiptap/markdown` keeps raw HTML as literal text, and the desktop converts the tags its schema knows (`<em>` to italic, `<br>` to a hard break, comments and unknown wrappers dropped). Literal text is not a safe fallback. Serializing it escapes the tags, so a phone save would write `<em>` back as `&lt;em&gt;` and damage the file for the desktop. So the phone parses HTML the way the desktop does.

The phone gives `@tiptap/markdown` a `DOMParser` backed by `linkedom`. linkedom's own `DOMParser` returns an empty body for a fragment, so the facade wraps the fragment in a full document before parsing. On Hermes the four HTML fixtures then give the desktop's tree. linkedom is large: the minified parser bundle grows from 500 KB to 950 KB (158 KB to 299 KB gzipped) and its Hermes bytecode from 0.95 MB to 1.6 MB. It loads lazily, the first time a document holds an `html` token, so a document without raw HTML pays nothing. The 50 KB budget in the first draft assumed a hand-rolled shim. ProseMirror's `DOMParser` walks a real DOM API, so a smaller facade over `htmlparser2` would reimplement most of linkedom.

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

Charts draw natively from `ChartSpec` with theme colors. Code highlights with the phone's CPU lexer (`apps/mobile/src/lib/lexer.ts`, the one the file viewer uses) and `SyntaxColors`, sent as color ranges per block. The colors are baked into the blocks, so the screen remounts the editor when the color scheme changes. Images under `images/<name>` load through `artifacts.file`. Links open only http(s), per `src/shared/documentLink.ts`.

Mermaid diagrams look the same as on the desktop. The desktop draws them with `pele`, which returns an SVG string, and `pele` runs on Hermes: a flowchart takes 33 ms and a sequence diagram 12 ms on the Mac's CPU. Without a canvas it estimates label widths, so boxes can be a little wider or narrower than the desktop's. Native code cannot draw an SVG string, and a WebView per diagram is the cost we avoid. So `packages/document-view/src/diagram.ts` reads `pele`'s SVG, which uses only `g`, `path`, `rect`, `circle`, `polygon`, `text`, `tspan` and `title`, applies the transforms, turns arcs, quadratics, rectangles, circles and polygons into absolute move, line, cubic and close operations, and maps `pele`'s CSS variables to theme roles (`@fg`, `@line`, `@surface` and the rest), as the desktop's `--pele-*` variables do. Native code draws paths and text. A diagram block shows its source until its drawing is ready, then the drawing replaces that block with one patch. `pele` and linkedom load on demand, only for documents that hold a diagram or raw HTML.

### Editing

The editing model is the desktop's own Tiptap `Editor`, running headless on Hermes (`packages/document-view/src/engine.ts`). Tiptap 3 skips mounting when there is no `document`, and its `view` becomes a proxy that only exposes `state` and `dispatch`. So the phone runs the desktop's command chains (`toggleBold`, `toggleTaskList`, `addRowAfter`) and its keymaps unchanged. Enter, Backspace, Delete and Tab are offered to the same keymap plugins with a synthetic key event and a minimal view whose `endOfTextblock` answers from the caret's offset in its block. Two details matter:

- A headless editor's state has no plugins. The engine builds it from `editor.extensionManager.plugins`.
- The document must be built with the editor's own schema. ProseMirror compares node types by identity, so a document from another `Schema` instance makes the trailing-node plugin append a paragraph on every keystroke. Parsing keeps the fast, conformance-tested `MarkdownManager` and only builds nodes with `editor.schema`, since the JSON between them does not depend on a schema.

Input rules (`## ` to a heading) stay off on the phone (see Out of scope).

| Headless editor on Hermes, Mac CPU, warm, load under 7 | 300 KB document |
| ------------------------------------------------------ | --------------- |
| Parse into the editor's schema                         | 328 ms          |
| One typed character, every desktop plugin, p50         | 3.4 ms          |
| One typed character, bare ProseMirror, p50             | 0.37 ms         |

Three of the desktop's `appendTransaction` plugins account for the gap: table cell fixing (about 1.1 ms), autolink (about 1.0 ms) and clear-document (about 0.8 ms). Each compares the top-level nodes of the old and new document, so the cost grows with the number of top-level blocks, about 0.8 µs each, not with the document's text. The desktop pays the same, and removing any of them would change behavior, so the phone keeps them. `prosemirror-kotlin` and a native model are not needed: the per-character model cost is well under a frame, and the native text view shows the character before JS runs. The bridge cost per character is measured with the editing slice (checkpoint 9).

The native text view of the focused block owns its text while the user types. It reports text diffs and selection changes, and JS applies them to the model as transactions. Typed characters therefore show up without waiting for JS. The model's cost shows up as CPU and as the delay before a structural edit (Enter, a toolbar command) redraws.

- No model change is pushed into a text view that has marked text. Input rules, normalization and mark changes wait until the composition commits. This is the same rule `packages/composer-editor` keeps, and it covers tiptap #5733 and #8626.
- Stale patches cannot undo typing. Every native edit raises the view's event count, and each patch JS sends down names the count it was computed from. The view drops a patch for its focused block that is older than its latest edit. The scheme and its reason are the composer's ("Stale renders cannot undo typing").
- Input arrives as replacements, not keys. Paste, autocorrect, dictation, swipe typing and GBoard's whole-word replacement (#5911, #7174) all reach JS as `{ from, to, text }` over the block's text, computed from the text before and after.
- Marks at boundaries are explicit. Typing after a mark change uses `storedMarks`, and links are not inclusive (#2571, #5849), as on the desktop.
- Enter, Backspace at the start of a block and Tab in a list are commands on the model, never text edits. The view intercepts them and calls `splitListItem`, `liftListItem`, `sinkListItem`, `joinBackward` and the rest, the same functions the desktop's keymap calls. Nested list backspace and task item edges (#2493, #3367, #4268) get one command test each, written first, with the desktop's result as the expected tree.

Selection that spans blocks is the risk in a view-per-block design. Checkpoint 8 prototypes it on both platforms before the editing slice: a drag that starts in one block extends a selection drawn by our own overlay across blocks, with the system handles inside one block. If it cannot be made to feel native, the alternative is one text view per run of contiguous text blocks, with tables, charts and images as separate views, and the recording goes into this doc.

### Saving

The saved format stays Markdown. The pure part of the desktop's save logic (revisions, edit counts, the 500 ms debounce, conflict, Keep mine, Use theirs, catching up on `artifact.updated` only when clean) lives in `src/shared/document/sync.ts`. It takes the rpc calls, the editor and the error formatter as functions, and the desktop's `documentSync.ts` is a thin adapter over it. The phone uses the same module. Serializing happens on the save debounce only. Opening a document never saves it. Only an edit makes it dirty.

### Live updates

A push of `artifact.updated` for a clean document re-reads it. The new Markdown is split into chunks, chunks with the same text as before reuse their parsed nodes, and top-level nodes equal to the shown ones keep their identity, so their blocks keep their ids. Native code gets a patch for the changed blocks only.

An edit works the same way. After any transaction the session finds the runs of top-level nodes that changed by object identity, re-renders only those runs, and shifts the positions after them. A keystroke in the middle of the 300 KB document sends one patch that replaces one block. Tiptap's trailing-node plugin appends an empty paragraph after the first transaction, as it does on the desktop, and that arrives as its own one-block patch.

### The bridge: `DocumentEditor`

`packages/document-view` is an Expo module with the same layout as `packages/composer-editor`. It exports one component, `DocumentEditor`, its types and the action registry. `document.tsx` uses nothing else, and no screen calls the native module directly. Everything native code sends is decoded with Effect Schema (`src/events.ts`) before it reaches the session.

```ts
type DocumentEditorProps = {
  readonly document: { readonly revision: number; readonly markdown: string }
  readonly theme: DocumentTheme
  readonly resolveImage: (path: string) => Promise<string>
  readonly highlightCode?: (code: string, language: string) => ReadonlyArray<CodeToken>
  readonly editable?: boolean
  readonly contentInset?: { readonly top: number; readonly bottom: number }
  readonly onChange?: () => void
  readonly onSelectionChange?: (selection: SelectionState) => void
  readonly onFocus?: () => void
  readonly onBlur?: () => void
  readonly onLinkPress?: (href: string) => void
  readonly onContentSizeChange?: (size: { readonly height: number }) => void
  readonly onError?: (error: { readonly kind: "unsupported" | "image" | "lossy"; readonly message: string }) => void
  readonly onReady?: (ready: { readonly capabilities: ReadonlyArray<Capability> }) => void
  readonly onLoaded?: (loaded: { readonly blocks: number }) => void
}

type DocumentEditorHandle = {
  readonly getMarkdown: () => string
  readonly run: (action: DocumentAction) => Promise<Result<"not-applicable" | "not-loaded">>
  readonly focus: () => Promise<Result<"not-loaded">>
  readonly blur: () => Promise<Result<"not-loaded">>
  readonly scrollTo: (position: number) => Promise<Result<"not-loaded">>
}

type SelectionState = {
  readonly active: ReadonlyArray<DocumentActionType>
  readonly available: ReadonlyArray<DocumentActionType>
  readonly heading: 1 | 2 | 3 | 4 | 5 | 6 | null
  readonly href: string | null
  readonly empty: boolean
}
```

`DocumentAction` (`src/actions.ts`) is a union of the desktop toolbar's actions: the four marks, `setLink`, `toggleHeading` with a level, the three lists, quote, callout and its tone, code block, list nesting, table insert and delete, add row or column after, delete row or column, `insertImage`, `undo` and `redo`. One registry maps each action to the desktop's Tiptap command chain and to its active test. `SelectionState` is what a toolbar needs to draw: the active actions, the actions the selection allows (dry runs through `editor.can()`), the heading level and the link under the caret. `onChange` says only that the document changed. The screen saves through the shared sync with `getMarkdown`. An action that cannot run returns a reason and never throws across the bridge. A capability one platform lacks is missing from `onReady`'s list.

The model lives in JS (see Editing), so this is what crosses the bridge:

| Direction | When                                            | Payload                                                                               |
| --------- | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| Down      | Open                                            | Render blocks for the first screen, then the rest as append patches                   |
| Up        | Each typed character                            | `edit { eventCount, block, cell, from, to, text }` in UTF-16 offsets, about 100 bytes |
| Down      | Each typed character                            | One patch replacing the edited block, carrying the event count                        |
| Up        | Caret move                                      | `select { anchor, head }`, each a `{ block, cell, offset }` point                     |
| Up        | Enter, Backspace or Delete at a block edge, Tab | `key { eventCount, key, shift }`                                                      |
| Down      | Structural key, action, `artifact.updated`      | Patches for the changed blocks, plus the new caret as a `selection`                   |

Stale patches cannot undo typing. Every native edit raises the view's event count, and every patch carries the latest count JS has applied. While a block is focused, the view applies a patch for it only when the patch's count is at least its own and no composition is active. If the patch's text equals what the view shows, the view keeps its text and caret and only takes the new id and styling. The budget is under 1 KB and 1 ms of bridge time per typed character. A synchronous or shared-object path is used only if a measurement shows the async one is too slow.

The names of block kinds, containers, marks, path operations, events, view functions and capabilities live in one file, `packages/document-view/src/protocol.ts`. `pnpm --dir packages/document-view protocol` writes `ios/Protocol.swift` and `android/.../Protocol.kt` from it, and `protocol.test.ts` fails when the generated files are stale. Native code switches over the generated enums, so a new kind fails to compile until both platforms handle it. `DocumentEditor.web.tsx` renders the document read-only so the Expo web build compiles.

```tsx
const editor = useRef<DocumentEditorHandle>(null)
const [selection, setSelection] = useState<SelectionState | null>(null)

<DocumentEditor
  ref={editor}
  document={document}
  editable={connected && !lossy}
  theme={documentTheme(theme, scheme)}
  highlightCode={highlighter(scheme)}
  resolveImage={async (path) => (await call("artifacts.file", { id, path })).dataUrl}
  contentInset={{ top: 0, bottom: keyboardHeight + TOOLBAR_HEIGHT }}
  onChange={sync.edited}
  onSelectionChange={setSelection}
  onLinkPress={openWebUrl}
/>

editor.current?.run({ type: "toggleHeading", level: 2 })
```

## Out of scope

Collaboration and creating comments. Comment highlights get a prop so they can be drawn later. Input rules (`## ` to a heading) wait until after the toolbar ships, and they run only after a composition commits.

## Verification

- Conformance in `pnpm test`. For every fixture in `src/shared/document/fixtures/`, Markdown to tree equals the desktop editor's `getJSON()`, tree to Markdown equals its `getMarkdown()`, and chunked parsing equals whole parsing. Command cases apply the same commands on a desktop `Editor` and on the shared model and compare trees. The desktop side runs in the existing Chromium component test runner.
- The fixtures cover every node and mark, deep nesting, the `@tiptap/markdown` round trip gaps (#8136, #8478, #8341, #8182, #8472, #8286, #8637), CJK, RTL, emoji and surrogate pairs, long unbroken strings, wide tables, an invalid chart, an unknown fence language, raw HTML, an empty document and a 300 KB document.
- A property test feeds random strings and random Markdown fragments to the parser. It never throws, and its result serializes and parses again. A second property checks that generated documents larger than one chunk parse as they would whole.
- Native, per block type, screenshots from the iOS simulator and the Android emulator next to the desktop rendering of the same fixture. A tree with an unknown node renders the fallback block.
- Editing, on both platforms: Japanese and Chinese with the system IME in a paragraph, a heading, a list item and a table cell, with and without an active mark. Paste of multiple paragraphs, an autocorrected word, undo and redo across a structural edit. Then the same document on the desktop shows the same Markdown. Short recordings go in the PRs.
- Performance through `scripts/perf/mobile.ts`'s document workload, against the baseline below. Simulator and emulator numbers are relative, not what a phone measures.

## Measurements

The baseline is the current screen (`document-segments.ts` and `react-native-enriched-markdown`), Release builds with the perf harness, at `cc4adf6d`. iOS ran on an iPhone 17 Pro Max simulator (iOS 27.0), and Android on an API 36 arm64 emulator, both on one Apple silicon Mac mini. Each value is a median over 3 runs, with 9 samples per open and 3 per large-document pass. The one-minute load average stayed between 2.9 and 9. These are relative numbers. A simulator runs on the Mac's CPU, and an emulator adds its own overhead.

| Measurement                                 | iOS before         | iOS after | Android before     | Android after |
| ------------------------------------------- | ------------------ | --------- | ------------------ | ------------- |
| Open small (2 KB), first content            | 89 ms              |           | 81 ms              |               |
| Open medium (30 KB), first content          | 92 ms              |           | 89 ms              |               |
| Open large (300 KB), first content          | 180 ms             |           | 745 ms             |               |
| Open, interactive (S / M / L)               | 700 / 776 / 759 ms |           | 315 / 493 / 746 ms |               |
| Parse in JS (S / M / L)                     | 1 / 14 / 106 ms    |           | 1 / 13 / 230 ms    |               |
| Handoff to native                           | not separable      |           | not separable      |               |
| Longest commit opening large                | 90 ms              |           | 405 ms             |               |
| Memory after opening large                  | 356 MB footprint   |           | 259 MB PSS         |               |
| Fling through large, native frame p95 / max | 16.7 / 38.9 ms     |           | 33.3 / 66.7 ms     |               |
| Fling, native frames over 32 ms             | 6                  |           | 55                 |               |
| Fling, `gfxinfo` janky frames / p99         | not available      |           | 72 / 73 ms         |               |
| One paragraph changed by `artifact.updated` | 203 ms             |           | 494 ms             |               |

How to read it:

- First content is the frame after the first commit that holds the document list, timed from JS. It does not see enriched-markdown's native layout after the commit.
- On iOS, interactive is dominated by the push transition. Its last commits are the screen freeze at about 670 ms and the list layout at about 735 ms, so all three sizes land near 700 to 800 ms.
- On Android, the large document arrives in one 400 to 550 ms commit after a 230 ms parse, so first content and interactive are the same. The JS thread's p95 frame during the fling is 104 ms.
- The old path has no separate handoff. Enriched-markdown parses Markdown again natively inside its view.
- Native frame gaps come from `CADisplayLink` and `Choreographer` (`packages/perf-frames`). They show main-thread stalls and miss render-thread and GPU work. Xcode's Hitches and Core Animation FPS instruments do not support the simulator.
- Every open also re-renders the hidden home list behind the document: 85 thread rows and about 1,100 link previews, about 6,600 component renders per open on iOS. That is a separate bug. It gets fixed on its own, and the after column is measured with the fix on both sides.
