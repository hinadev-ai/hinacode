# Native composer editor

## Problem

The phone composer is a `TextInput` with nested `Text` spans. It can tint a skill, but it cannot draw the desktop's chip, because a `TextInput` only takes text: an inline `Image` crashes Fabric on Android (`Unable to add a view into a non-ViewGroup`). It also gets slow on long drafts, since every keystroke rebuilds and resends every span: about 195 ms of CPU per typed character on an 18 KB draft on the Android emulator.

Rich text libraries do not fit either. Tiptap has no React Native build, so it needs a WebView. `react-native-enriched-markdown`'s input and Tiptap both rewrite pasted prompts: backticks, `_` and `*` disappear, `#` lines turn into headings, and Tiptap doubles newlines. An agent prompt has to arrive exactly as typed.

## User flow

The user types or pastes into the composer. A skill or command at the start of the message shows as a chip with the same icon the desktop draws (`skillIconShape`, or `slashIconShape` for built-ins), mentions are tinted, and code has a background. What gets sent is the text the user typed, character for character.

## Design

`packages/composer-editor` is an Expo module with one view, `ComposerEditor`.

- **Plain text is the model.** JS owns the string. It computes `Decoration` ranges (`chip`, `token`, `code`, `muted`) with `composerDecorations`, which reuses the desktop's `composerSyntax`. Native code only draws them. A new highlight, such as links, is a new case in `composerDecorations` and, for a new look, a new `kind` in both native views.
- **A chip never changes the text.** The native view draws the icon in place of the token's first character, the `/` or `$` trigger, and paints a rounded pill behind the whole token. On Android that is a `ReplacementSpan` over the trigger plus pills drawn in `EditText.onDraw`. On iOS the trigger is transparent and kerned to the icon's width, and a TextKit 1 `NSLayoutManager` draws the pill and the icon. The name stays real text, so the caret, selection and line wrapping work as usual.
- **Icons come from `@hinacode/icons`.** `iconPaths` reads a shape's `Path`, `Rect` and `Circle` elements into SVG path strings. Android parses them with `PathParser`, and iOS with a small parser that only needs circle arcs, since the icon rules allow no other curves.
- **Stale renders cannot undo typing.** Each native edit raises an event count, and JS sends back the last count it saw with the value. The view ignores a value older than its latest edit, applies a newer one by replacing only the part that differs, and draws decorations only over the exact text they were computed for. iOS skips restyling while the keyboard is composing (Japanese, Chinese), because changing attributes ends the composition.
- **The field sizes itself.** The view reports its content height, and the wrapper sets it as the height, so `minHeight` and `maxHeight` on `style` bound the growth.

The web build keeps `ComposerInput`'s transparent-textarea overlay.

## Measurements

Android 15 emulator (x86_64, release build), 240 characters typed through `adb input text`, 3 runs each. CPU is the app plus WebView processes. The emulator reports no power figures, so CPU time stands in for battery.

| Editor                           | Ready after mount           | CPU per char, 1.5 KB draft | CPU per char, 18 KB draft | Memory (PSS)  | Paste kept exactly |
| -------------------------------- | --------------------------- | -------------------------- | ------------------------- | ------------- | ------------------ |
| `TextInput` with spans (current) | 48 to 64 ms                 | 30 to 31 ms                | 192 to 199 ms             | 116 to 160 MB | yes                |
| `EnrichedMarkdownTextInput`      | 45 to 50 ms                 | 31 to 34 ms                | 96 to 101 ms              | 121 to 128 MB | no                 |
| Tiptap in a WebView              | 0.9 to 1.1 s warm, 9 s cold | 24 to 25 ms                | not run                   | 223 MB        | no                 |
| `ComposerEditor`                 | 31 to 55 ms                 | 31 to 36 ms                | 47 to 54 ms               | 100 to 115 MB | yes                |

Tiptap with StarterKit, Link and Mention adds 426 KB minified (137 KB gzipped) of JavaScript. `ComposerEditor` adds about 30 KB of Kotlin and Swift source and no JavaScript dependency.

## Out of scope

- Atomic chips. Backspace into a skill still goes through `keepSkillWhole` in JS, as today.
- Tapping a chip, and chips for mentions or links.
- Image paste.

## Verify

- `pnpm test` covers `composerDecorations` and `iconPaths`.
- Build the Android app (`pnpm android`), open a thread and type `/` plus a skill: the chip shows the skill icon on a tinted pill. Paste a prompt with backticks, underscores and a code fence, send it, and check the transcript shows it unchanged.
- Build the iOS app (`pnpm ios`) and check the same flow, plus Japanese input after a chip: the whole composition stays until it is committed. Select a word and pick Bold from the edit menu: it renders bold between muted `**` and stays selected.
