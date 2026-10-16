# Shortcut `when` clauses and composer picker shortcuts

Status: Shipped
Date: 2026-10-14

## Problem

On Linux and Windows, `mod` is Ctrl, and the shell uses many Ctrl chords. wterm sends the Ctrl chords it can encode to the shell and stops them, so inside the terminal no app shortcut ran at all, not even `mod+j` to close the terminal or `mod+p` for the palette. Letting every app chord through instead would steal Ctrl+L (clear), Ctrl+B and Ctrl+F (cursor movement), Ctrl+N (history) and Ctrl+Shift+C (copy).

Changing the model or the reasoning effort also needed the pointer.

## User flow

- In the terminal, Ctrl+L clears the screen and Ctrl+B moves the cursor back, while Ctrl+P opens the palette, Ctrl+J closes the terminal and focus returns to the message box.
- Settings > Keybindings shows "Not in the terminal" under the shortcuts the shell keeps.
- `mod+alt+.` opens the model picker and `mod+alt+,` opens the effort picker. Arrow keys choose, Enter applies, and focus goes back to where it was, usually the message box.

## Design

- `Command.when` is a VS Code style clause over `KeyContext`, today only `terminalFocus`: `"terminalFocus"` or `"!terminalFocus"`. `whenHolds` evaluates it. The palette ignores it, as VS Code's does.
- `useKeybindings` checks the clause in its TanStack Hotkeys callback. It also listens for keydown in the capture phase, so a Control or Meta chord typed into the terminal whose clause holds runs before wterm sees it. This is VS Code's `commandsToSkipShell`, with the `when` clause as the only switch.
- `composer.model` and `composer.effort` call `useUi.requestPicker`. The model and effort selects are controlled through `usePickerOpen`, which opens on the request and hands focus back through Base UI's `finalFocus`.

## Out of scope

- User-editable `when` clauses. The clause lives with the command, and overrides only change the chord.
- On macOS, Cmd chords never reach the shell, but a command with `!terminalFocus` still does nothing in the terminal. VS Code separates the two with a Meta rule. Add it only if a Mac user misses Cmd+B there.

## Verification

`commands.test.ts` covers `whenHolds`. In the real app with `verify-hinacode`: Ctrl+L in the terminal clears the screen and keeps focus, Ctrl+B leaves the sidebar alone, Ctrl+P opens the palette and Ctrl+J closes the terminal, and both picker shortcuts open their select and return focus to the message box.
