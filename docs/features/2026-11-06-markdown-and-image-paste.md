# Markdown and image paste

Status: Shipped
Date: 2026-11-06

## Problem

A developer copies a section of a web page and pastes it into the composer. The composer is plain text, so the bold and italic that carried the emphasis are gone. Converting the whole page to markdown was the first answer, and it was too much: a paste arrived full of `##`, `[text](url)`, `![image](url)`, table pipes and escaped `\_`, which the developer then deleted by hand.

The document editor has the opposite gaps. Markdown copied from a file or a chat lands as literal `##` and `-` characters. A pasted screenshot does nothing, because the editor has nowhere to keep the bytes.

## User flow

1. Copy formatted content in a browser, then paste it into the composer. The composer inserts its text and keeps only the inline formats: `**bold**`, `*italic*`, `~~strikethrough~~` and `` `code` ``. Headings, lists, quotes, links, images, tables and code blocks paste as their text.
2. Copy markdown text, then paste it into a document. It renders as headings, lists and code blocks.
3. Paste a screenshot into a document. It appears at the caret, and the document saves as usual.
4. To paste text without conversion, use the platform's plain-text paste shortcut (Ctrl+Shift+V or Cmd+Shift+Option+V). It only offers `text/plain`, so neither surface converts it.

## Design

The clipboard rules live in `src/renderer/lib/clipboardMarkdown.ts`:

- The composer converts HTML only when it holds an inline format: bold, italic, strikethrough or inline code. Anything else pastes as `text/plain`, so a copied page without emphasis, and the styled `<span>`s editors like VS Code put on the clipboard, arrive exactly as the browser wrote them.
- The conversion is `turndown` with its block, link and image rules replaced by ones that return the text, and with escaping off, so `a_b * 2` stays as typed. A table row keeps its cells on one line, separated by tabs, the way `text/plain` has them.
- For the document, HTML counts as formatted when it carries structure markdown can express, such as a link, heading, list, code, table, quote or emphasis. The document keeps ProseMirror's own HTML paste for formatted HTML and for copies from another document. Otherwise it parses `text/plain` as markdown, unless the caret is in a code block.

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
- `src/renderer/components/ComposerInput.component.test.tsx` pastes a formatted web page and checks that only the inline formats survive, and that a page without them pastes as its plain text.
- In the real app, paste formatted HTML into the composer, and paste markdown and a PNG into a document. The image survives a reload and appears in the PDF export.
