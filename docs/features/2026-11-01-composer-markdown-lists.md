# Composer lists, quotes, bold and rules

Status: Shipped
Date: 2026-11-01

## Problem

Developers write multi-step prompts as lists. The composer colored a `- ` marker but left the rest to them: every new item meant typing the marker again, and renumbering by hand. Bold and `---` showed as raw markdown, so a long prompt was hard to scan before sending.

## User flow

- Type `- review` or `1. first`, press Shift+Enter. The next line starts with `- ` or `2. `, at the same indent. A task item `- [x]` continues as `- [ ] `.
- Press Shift+Enter on an empty item to end the list. Backspace right after a marker removes the marker and keeps the indent.
- `-`, `*` and `+` markers show as `•`. Numbers stay as typed.
- A list item is indented, and a long item wraps under its first word, not under its marker. A nested item sits further in, by the spaces in front of it.
- Type `> ` at the start of a line to quote it. The marker hides and the line gets a bar on its left. Shift+Enter starts the next quoted line, Shift+Enter on an empty one leaves the quote, and Backspace right after the marker removes it.
- `**text**` shows bold, with its markers muted.
- A line of `---`, `***` or `___` draws a rule. Moving the caret onto it shows the raw text again, so it stays editable.
- The sent message bubble renders bold and rules the same way.

## Design

The composer still holds plain markdown, and that is what the agent receives. Nothing is stored differently.

- `src/shared/composerSyntax.ts` adds the `strong`, `rule` and `quote` segment kinds to `highlight`, and the pure edits `continueList`, `listBackspace`, `continueQuote` and `quoteBackspace`. They return `null` inside a fenced block.
- `src/renderer/lib/composerMarks.ts` turns segments into editor marks: `strong` plus muted `marker`s, `listItem` and `dot` for bullets, `quoteLine` and `hidden` for a quote, `rule` unless the caret is on that line.
- `src/renderer/lib/composerEditor.ts` draws `dot` and `rule` as replace widgets. Dots and hidden quote markers join the command chips in the atomic ranges.
- A list line hangs its wrapped text with a negative `text-indent` and the same `padding-inline-start`. That needs the width of everything before the text, which CSS cannot measure, so the indent and the marker each sit in an inline box of a known width: 0.5em per column of indent, and 1.25em for the marker, which holds a one-digit number. A marker from `10.` on is wider and pushes its first line slightly right of the wrapped lines.
- A hidden quote marker leaves two caret positions at the same place. A transaction filter moves a caret that lands before the marker to after it, so Home and a click at the line start cannot type in front of the `>`. The filter cannot tell Home from Arrow Left, so a key binding takes Arrow Left and word-left from the first quoted character to the end of the previous line.
- `ComposerInput.tsx` applies the list and quote edits on Shift+Enter and Backspace before the default keymap.

## Out of scope

- A bold shortcut. `mod+b` already toggles the sidebar.
- Renumbering the items after an inserted one, and Tab to indent.
- Setext headings. A `---` under text is a rule here, not an `h2`.
- Nested quotes, and lists inside a quote. Only `> ` at column 0 is a quote.
- Indents and the quote bar in the sent message bubble, which still shows the list and quote markers inline.

## Verification

`composerSyntax.test.ts` and `composerMarks.test.ts` cover the edits and marks. `ComposerInput.component.test.tsx` drives Shift+Enter, Backspace, Home and Arrow Left in Chromium, and measures where a wrapped item's lines start. In the real app, type a list, a quote, a bold word and `---` into a new thread's composer with `verify-hinacode`.
