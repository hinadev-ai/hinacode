# Skill chips in the composer

Status: Building
Date: 2026-10-18

## Problem

Skills and the agent's own commands share one completion list and one look. A developer scanning `/` cannot tell `/kalan-mode`, a playbook they wrote, from `/compact`, an action of Claude Code. Once picked, a skill is colored text at the start of the message, so it is easy to miss and easy to break with a stray keystroke.

## User flow

1. The developer types `/` (Claude Code, Muse Code) or `$` (Codex). Skills show a box icon and their name in the token color. The agent's own commands show the slash-command icon and plain text. The end of each row says what it is: Command, User skill, Project skill, or Skill when it comes from elsewhere, such as a plugin.
2. Enter, Tab or a click picks a skill, and it becomes a chip before the text. Typing a skill's full name and a space at the start of the message does the same. The caret sits after the chip, and the skill's argument hint, if it has one, is the placeholder.
3. Backspace at the start of the text removes the whole chip and keeps the text.
4. Send sends the same text as before, `/name args` or `$name args`.

## Design

- `AgentCommand` gains an optional `builtin`, copied from the Claude Agent SDK's `SlashCommand.builtin`. Codex and Muse Code list only skills and leave it out. Optional keeps a desktop, a cloud and a phone on different versions decoding each other's `commands.list`.
- It also gains an optional `scope`, `user` or `project`. Codex reports a skill's `scope` (`repo` is the project) and Muse Code its `source`. Claude Code only appends `(user)` or `(project)` to the description, so `claude/commands.ts` moves that suffix into `scope`. Other sources, such as plugins, bundled skills and Claude's `(claude.ai sync)`, get no scope and keep their description as is.
- The draft text stays the only state. `leadingSkill` in `composerSyntax.ts` finds a skill token and the space after it at the start of the text. `ComposerInput` puts the rest in the textarea and draws the chip in the highlight layer under it.
- The chip sits at the start of the first line. A `ResizeObserver` writes its width to `--skill-chip-width`, and the textarea and the highlight layer both indent their first line by it, so they still wrap identically and the caret lines up with the text.
- Caret positions are offsets into the textarea's text. When a chip appears or goes away, the composer renders synchronously and puts the caret back, as picking a suggestion already did.
- The chip is at most half the line wide. A text indent leaves no break opportunity before the first word, so a word wider than the room beside the chip would break mid-word.
- Screen readers hear the skill in the textarea's description, "Skill: kalan-mode".
- The phone has no chip element. `composerSpans` in `apps/mobile/src/lib/composer-text.ts` tints the leading skill and colors the same tokens as `highlight`, rendered as `Text` nested in the native `TextInput` and, on the web build, as a copy under a transparent textarea. A deletion that cuts into the skill removes it whole, the phone's version of Backspace after the chip.

## Out of scope

- Chips in the middle of a message. Claude Code and Muse Code run a skill only when it starts the message. Codex runs `$name` anywhere, and those stay highlighted text, because chips anywhere need a contenteditable editor instead of the textarea.
- Chips for the agent's own commands, which run an action instead of adding instructions.
- Chips in sent messages.

## Verification

- `composerSyntax.test.ts` covers `leadingSkill`, and `claude/commands.test.ts` and `muse/skills.test.ts` cover the scopes.
- `e2e/features/composer-skills.feature` runs against the simulated Claude: it checks each row's label, picks a skill, sends it, removes a chip with Backspace, and keeps `/compact` as text.
- With `verify-hinacode`, open a Claude thread, type `/` and compare skills with built-in commands, then pick a skill and type a long message after it, in light and dark and in a narrow window.
