# Markdown and image paste

Status: Shipped
Date: 2026-11-06

## Problem

A developer copies a section of a web page, such as a spec with headings, lists, links and a code block, and pastes it into the composer. The composer is plain text, so the agent receives the text with every link and code fence stripped.

The document editor has the opposite gaps. Markdown copied from a file or a chat lands as literal `##` and `-` characters. A pasted screenshot does nothing, because the editor has nowhere to keep the bytes.

## User flow

1. Copy formatted content in a browser, then paste it into the composer. The composer inserts the markdown for it: `## Heading`, `- item`, `[text](url)`, fenced code.
2. Copy markdown text, then paste it into a document. It renders as headings, lists and code blocks.
3. Paste a screenshot into a document. It appears at the caret, and the document saves as usual.
4. To paste text without conversion, use the platform's plain-text paste shortcut (Ctrl+Shift+V or Cmd+Shift+Option+V). It only offers `text/plain`, so neither surface converts it.

## Design

The clipboard rules live in `src/renderer/lib/clipboardMarkdown.ts`:

- HTML counts as formatted when it carries structure markdown can express, such as a link, heading, list, code, table, quote or emphasis. Editors like VS Code put styled `<span>`s on the clipboard, and those paste as plain text, so copied code is never rewritten.
- The composer turns formatted HTML into markdown with `turndown` and its GFM plugin, which covers tables, strikethrough and task lists.
- The document keeps ProseMirror's own HTML paste for formatted HTML and for copies from another document. Otherwise it parses `text/plain` as markdown, unless the caret is in a code block.

A pasted image is stored with its document, not inlined:

- `artifacts.addDocumentImage({ id, dataUrl })` returns `{ path }`. The store writes the bytes to `<artifact>/images/<sha256>.<ext>`, outside the numbered version directories. Republishing the document, by the developer or an agent, therefore never drops an image. The same bytes always map to the same path, so pasting the same image twice stores one file.
- Only PNG, JPEG, GIF and WebP are accepted, up to the artifact size limit. The path goes through `normalizeArtifactPath` like every artifact file.
- The markdown references the image as `images/<hash>.png`. An agent reading the document gets a short path, not megabytes of base64.
- The editor shows relative image paths through `artifactUrl`, so `artifacts.file` serves them on the desktop, the cloud daemon and the web app alike.
- PDF export inlines these images as data URLs, because the print page only allows `data:` images.

## Out of scope

- Removing images a document no longer references. They go away with the document. Collecting them would race the editor's undo history.
- Exporting a document as markdown with its images. The exported `.md` keeps the relative paths.
- Drag and drop of image files into a document.

## Verification

- `packages/artifacts/src/store.test.ts` covers storing, serving and rejecting images.
- `src/renderer/components/ComposerInput.component.test.tsx` pastes a formatted web page as markdown.
- In the real app, paste formatted HTML into the composer, and paste markdown and a PNG into a document. The image survives a reload and appears in the PDF export.
