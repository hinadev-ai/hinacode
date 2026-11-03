# Document artifacts

Status: Building
Date: 2026-11-03

## Problem

An agent's plan, spec or checklist is prose the developer wants to change, not a page to look at. Today the agent can publish it as an HTML artifact, which the developer can read but not edit, or write a Markdown file into the worktree, which then has to be kept out of the commit. Either way the developer's edits cannot reach the agent without copying text into the composer.

Claude's documents show the shape that works: a document opens beside its conversation, the developer edits it in a rich-text editor, it saves on its own, and the agent can read the edited version. We build that on top of our artifacts, without Claude's hosted service, sharing or collaboration.

## User flow

1. The agent calls `publish_document` with a title and Markdown. The transcript shows a document card, and clicking it opens the document in the Artifacts side panel.
2. The developer can also press New document in the Artifacts panel. An empty Untitled document opens, owned by the thread.
3. The developer edits with a toolbar: headings, bold, italic, strikethrough, inline code, lists, task lists, quotes, code blocks, links and tables. The toolbar says Saving and then Saved.
4. Ask agent puts a line in the thread's draft that names the document and its revision, so the agent reads the edits before acting.
5. The agent calls `publish_document` again with the id and the revision it knows. If the developer saved since, the call fails and returns the developer's text and revision, so the agent merges and publishes again. The open editor loads the agent's version when it has no unsaved edits.
6. Export saves the Markdown file, or a PDF of the document as the editor shows it.

## Design

### Data shape

A document is an artifact with `kind: "document"`. It keeps the artifact's id, versions, thread ownership, list, delete, watcher events and cloud routing. Its only file is `document.md`, which is also its entry.

```ts
type ArtifactKind = "page" | "document"

type Artifact = {
  id: string
  kind: ArtifactKind
  title: string
  entry: string
  version: number
  revision: number
  author: "agent" | "developer"
  files: ArtifactFile[]
  createdAt: string
  updatedAt: string
  threadId?: string
}

type PublishInput =
  | { kind?: "page"; id?; title?; threadId?; baseRevision?; author?; entry?; files }
  | { kind: "document"; id?; title?; threadId?; baseRevision?; author?; markdown }
```

- `kind` defaults to `page` when a manifest predates it, so old artifacts read unchanged.
- A document input has no `files` or `entry`, so a document with HTML in it, or with a second file, cannot be written. An update cannot change an artifact's kind.
- `version` is what a person refers to, such as `v3` in the header. `revision` counts every write. Autosave writes every half second of typing, so one version per save would turn a short edit into dozens of versions.
- An agent's publish always starts a new version. The developer's first save after it starts one more, and their later saves rewrite that version in place, with `author: "developer"`. So every handoff between agent and developer keeps the other side's text as the previous version, and the store keeps the current and previous version as before.
- `baseRevision` is optimistic concurrency. Under the artifact's lock, a publish whose `baseRevision` is not the current revision fails with `ArtifactConflictError`, which carries the current manifest. The editor and `publish_document` both send it, so neither side overwrites edits it has not seen, even edits made in place. The agent's `revision` is required with `id` for that reason.
- Manifests written before these fields read as `revision: 0` and `author: "agent"`.
- The title is a name, not content. The developer renames an artifact by clicking its title in the panel header, and `store.rename` rewrites only the manifest's `title` and `updatedAt`, so a rename neither bumps the revision nor conflicts with an edit in flight. An update without `title` keeps the current one, and both publish tools tell the agent to omit it, so a stale title from the agent does not undo the rename. A new artifact still needs one.

The persisted format is Markdown, not the editor's JSON. Agents read and write Markdown well, the file is readable and diffable on disk, and export is the file itself. The editor's schema becomes a view of the file rather than the format. The cost is that Markdown the editor cannot represent, such as raw HTML, is dropped the first time the developer saves. The tool description says so.

### Editor

The renderer edits documents with Tiptap over ProseMirror and `@tiptap/markdown`, using StarterKit, task lists, tables and images. Saves go through `artifacts.saveDocument`, which writes as the developer.

The toolbar holds block tools. Bold, italic, strikethrough, inline code and links live in a menu over the selected text. Links follow Notion and Claude's editor: nothing pops up when the caret moves into a link, because a card that follows the caret covers the line being typed. Hovering a link for half a second shows a card with its address, Copy, Edit and Remove; the card stays while the pointer moves onto it. Cmd+K, the menu's link button or Edit opens a form with the link's text and address, and highlights the range it will change while focus is in the form. With the caret inside a link, Cmd+K edits that link, which is the keyboard path to change or remove it. Cmd+click opens a link. Links accept http(s) and mailto only, and a bare host gets `https://` (`src/shared/documentLink.ts`). A table shows its own menu at its top right: add or delete a row or column, and Delete table. Every code block has a language picker in its corner, which can also turn the block into a chart.

The editor stops a key it handled from reaching the app's shortcuts, so Cmd+B makes text bold without also toggling the sidebar. Controls inside a block's node view, such as the language picker, keep their events from the editor, so choosing from them never moves the caret. Code blocks are colored with the same shiki highlighter and code theme as the transcript, in the language the fence names. A ProseMirror plugin turns the tokens into decorations, so the colors never reach the Markdown.

The editor follows a small state machine: `saved`, `dirty`, `saving`, `conflict`. A save waits for a short pause in typing. The editor saves only after a change the developer made, never after loading content, so opening an agent's document does not rewrite its Markdown. A transaction that only normalizes the document, such as the empty paragraph ProseMirror appends after a final code block, does not count as an edit. A newer revision in `artifact.updated` replaces the content when the editor is `saved`. When the editor holds unsaved edits, the next save fails with a conflict, and the panel offers Keep mine (save over the new version) or Use theirs (load it and drop the edits).

Closing the editor saves pending edits at once. If that save fails or conflicts, the edits and the revision they started from stay in memory, so reopening the document restores them and raises the conflict again. They do not survive quitting the app.

### Charts

A chart is a fenced code block whose language is `chart` and whose body is JSON, so it round-trips through Markdown and the agent writes it like any fence:

```ts
type ChartSpec = {
  type: "bar" | "line"
  title?: string
  notes?: string
  x: string
  series: Array<{ key: string; label?: string }>
  unit?: { prefix?: string; suffix?: string }
  rows: Array<Record<string, string | number | null>>
}
```

A bar chart stacks its series and a line chart draws one line per series. The highest point gets a label. Colors come from the theme's `--graph-lane-*` tokens, so the agent never picks one. At most 6 series and 500 rows. `src/shared/documentChart.ts` decodes the JSON with a schema, because the agent wrote it, and a chart that fails shows its error and its source instead of a blank box.

In the editor, a code block whose language is `chart` becomes a card with the title, notes, legend and plot, plus Data (the rows as a table) and Source (the JSON, editable, redrawing as you type). Every other code block keeps a plain view.

Two things load only when needed. Observable Plot, which draws the SVG, is a lazy chunk imported when a document contains a chart. The chart syntax is about 450 tokens that agents need only when drawing one, so it is not in the thread instructions or the `publish_document` description. That description says charts exist and points at `document_chart_guide`, which returns `CHART_GUIDE`. A test parses the guide's example with the renderer's parser, so the guide cannot teach a chart that does not draw.

### Export

Markdown export writes the stored `document.md`. PDF export prints what the editor renders, so tables, checklists and highlighted code look the same on paper. The renderer copies the editor's DOM, with each checkbox's state written into its `checked` attribute, and sends it as `artifacts.export` with `format: "document-pdf"`. A page export carries an artifact id and entry instead, and the request is a union so neither can carry the other's fields. Main wraps the HTML in a print page (`src/shared/documentPrint.ts`) whose CSP allows no script and no network, adds the app theme, and prints it in the same hidden sandboxed window as a page's PDF. Page margins are padding repeated on every page, so the theme's background reaches the paper's edge.

### Trust boundary

Pages are hostile HTML and stay in the sandboxed frame. A document is not HTML. Its Markdown goes through the editor's schema, which only creates the nodes the toolbar can make. Unknown HTML is dropped or kept as text, and nothing in it runs. Links never navigate: they do not open on click, and `javascript:` URLs are refused when the Markdown is parsed. Images load under the renderer's CSP, the same as in transcript Markdown. A plain remote URL does not load, but its node stays in the Markdown.

### rpc

- `artifacts.readDocument({ id })` answers `{ version, revision, markdown }`, read together so the content and revision match.
- `artifacts.saveDocument({ id, baseRevision, markdown })` answers `{ type: "saved", version, revision }` or `{ type: "conflict", version, revision, markdown }`.
- `artifacts.createDocument({ threadId, title })` publishes an empty document owned by the thread.
- `artifacts.rename({ id, title })` renames a page or a document and answers its manifest.

`createDocument` routes by the thread's owner and the others by the artifact's, so a document on a cloud machine edits the same way.

## Out of scope

- Live collaboration, comments, sharing, public links and access control.
- Version history in the UI.
- Exports other than Markdown and PDF.
- Uploading images into a document.
- Starting a new thread from a document.
- Pie, area and scatter charts, chart colors chosen by the agent, and charts in transcript Markdown.

## Verification

- `packages/artifacts`: store tests for documents, legacy manifests, kind changes, in-place developer saves and stale revisions. Tool tests for `publish_document` and its conflict answer.
- The real app with `verify-hinacode`: `/mock-documents` publishes a document through the real MCP server. Open the card, edit, see Saved, reload the app and see the edit. Publish again from the mock with a stale revision and see the conflict reach the agent. Create a document from the panel.
