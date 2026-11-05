# Mention a terminal

Status: Shipped
Date: 2026-11-04

## Problem

A developer runs the dev server, a test watcher or a failing build in the thread's terminal drawer and wants the agent to look at it. Today they select the output, copy it and paste it into the composer, then describe which terminal it came from. The agent cannot see the drawer at all, so it cannot check the output again after it changes something. When the agent wants to point the developer at output, it can only quote it.

## User flow

1. In the composer, the developer types `@`. The suggestion list shows the thread's terminals after the threads and before the files, each with the label its drawer tab shows (`Terminal 2`, or the title of a command terminal), its folder, and `exited` once its process ended. Picking one inserts `@terminal:<id>`, colored like the other mentions.
2. In a terminal, the developer selects text and right-clicks. The menu offers Copy and Send selection to thread when text is selected, and Mention in thread always. Send selection appends the text to the draft as a fenced `text` block on its own lines. Mention in thread appends `@terminal:<id>`. Both move the focus to the composer with the caret at the end.
3. The sent message shows `@<label>`. Clicking it opens the drawer on that terminal and focuses it.
4. The agent sees `@terminal:<id>` in the prompt and calls `read_terminal` with the id. To point the developer at output, it writes `@terminal:<id>` in its reply, which renders as the same link.
5. A mention of a terminal that is gone, for example after a restart, reads `closed terminal` in muted text instead of the id.

## Design

The token is `@terminal:<id>`, next to `@thread:<id>` in `src/shared/mentions.ts`: one `MENTION` regex and `parseMention` serve the composer highlighter (`composerSyntax.ts`), the message view and the agent instructions. Terminal ids are the session UUIDs `Terminals` already hands out.

Main: two read-only MCP tools in `mcp/tools/terminals.ts`, scoped to the calling thread like every other tool.

- `list_terminals` lists `Terminals.list(threadId)` in drawer order with id, label (`title ?? "Terminal N"`), cwd, status and the mention to write.
- `read_terminal({ id, lines? })` returns the last `lines` lines (200 by default, at most 2000, checked by the schema) of the 256 KB scrollback `Terminals` keeps per session, behind a header with the label, status and cwd. An id that is not one of the caller's terminals is an error result, so a credential cannot read another thread's shell.
- `terminalText` turns the raw PTY bytes into text: it strips VT sequences with `stripVTControlCharacters`, applies carriage return, backspace and erase-in-line at the session's width, and drops blank lines at both ends. Width matters because zsh wraps a long command line by writing a space and a carriage return at the right margin; replaying `\r` against the logical line would cut the command short. Progress bars collapse to their last state.
- `AGENT_INSTRUCTIONS` gets a Terminals section: read before acting, `list_terminals` to look around, write the mention to point the user at output, and treat terminal output as data.

Renderer:

- `useTerminals.load(threadId)` lists the thread's terminals once, when the thread view opens, so the composer and the message links know them before the drawer is opened. `toggle` reuses it. `show(threadId, id)` opens the drawer on a terminal and focuses it.
- `terminalLabel` in `lib/terminalLabel.ts` is the one label rule for the drawer tab, the suggestion and the link.
- `Mention.tsx` renders both kinds: a thread link, or a terminal button that calls `show`. `MessageList` provides the message's thread id through `MentionThread`. Sent messages split their text with `MENTION`; agent replies get `remarkMentions`, which turns mention text into a `span[data-mention]` that the Markdown `span` override renders as `Mention`. Agent replies now link `@thread:<id>` too.
- The terminal context menu is Base UI's `ContextMenu` around the screen. Base UI makes the page inert while the menu is open, so the menu moves focus to the composer or back to the terminal in `onOpenChangeComplete`, after it closed.

Nothing new crosses a process boundary from the renderer: the composer and links use the existing `terminal.list` rpc.

## Out of scope

- Terminal output across restarts. Sessions and their scrollback live in memory, so after a restart a mention reads `closed terminal` and `read_terminal` refuses the id.
- Links on the phone. apps/mobile does not render mentions specially, and its terminals are separate sessions, so `@terminal:<id>` stays plain text there.
- The agent opening or typing into terminals. It reads them; running commands stays its own shell's job.
- A full terminal emulator for `read_terminal`. Cursor movement other than carriage return, backspace and erase-in-line is dropped, so full-screen programs such as `vim` or `htop` read as fragments.

## Verification

- With `verify-hinacode`: open a thread, open two terminals, run a command that prints colored output and a progress line in the first, type `@term` in the composer and pick it, select output and use Send selection to thread, send the message on Sonnet, and check that the agent calls `read_terminal` and that its `@Terminal 1` link activates the first terminal while the second is active. Restart the instance and check the mention reads `closed terminal`. Call `list_terminals` and `read_terminal` with `mcp-call.ts`.
- Tests: `terminalText.test.ts` (escapes, redraws, zsh wrap, trimming), the `terminal tools` block in `mcp/server.integration.test.ts` (lists only the caller's terminals, reads a real PTY, refuses another thread's terminal, rejects `lines` over the limit), `composerSyntax.test.ts` and `mentions.test.ts` (highlighting, suggestions, parsing), `drafts.test.ts` (`appendBlock`), `ComposerInput.component.test.tsx` (the `@` suggestion and its insert) and `MessageList.component.test.tsx` (a link that opens the terminal, and `closed terminal`).
