# Composer lists, bold and rules

Status: Shipped
Date: 2026-11-01

## Problem

Developers write multi-step prompts as lists. The composer colored a `- ` marker but left the rest to them: every new item meant typing the marker again, and renumbering by hand. Bold and `---` showed as raw markdown, so a long prompt was hard to scan before sending.

## User flow

- Type `- review` or `1. first`, press Shift+Enter. The next line starts with `- ` or `2. `, at the same indent. A task item `- [x]` continues as `- [ ] `.
- Press Shift+Enter on an empty item to end the list. Backspace right after a marker removes the marker and keeps the indent.
- `-`, `*` and `+` markers show as `•`. Numbers stay as typed.
- `**text**` shows bold, with its markers muted.
- A line of `---`, `***` or `___` draws a rule. Moving the caret onto it shows the raw text again, so it stays editable.
- The sent message bubble renders bold and rules the same way.

## Design

The composer still holds plain markdown, and that is what the agent receives. Nothing is stored differently.

- `src/shared/composerSyntax.ts` adds the `strong` and `rule` segment kinds to `highlight`, and two pure edits, `continueList` and `listBackspace`. Both return `null` inside a fenced block.
- `src/renderer/lib/composerMarks.ts` turns segments into editor marks: `strong` plus muted `marker`s, `dot` for bullets, `rule` unless the caret is on that line.
- `src/renderer/lib/composerEditor.ts` draws `dot` and `rule` as replace widgets. Dots join the command chips in the atomic ranges.
- `ComposerInput.tsx` applies the list edits on Shift+Enter and Backspace before the default keymap.

## Out of scope

- A bold shortcut. `mod+b` already toggles the sidebar.
- Renumbering the items after an inserted one, and Tab to indent.
- Setext headings. A `---` under text is a rule here, not an `h2`.

## Verification

`composerSyntax.test.ts` and `composerMarks.test.ts` cover the edits and marks. `ComposerInput.component.test.tsx` drives Shift+Enter and Backspace in Chromium. In the real app, type a list, a bold word and `---` into a new thread's composer with `verify-hinacode`.
