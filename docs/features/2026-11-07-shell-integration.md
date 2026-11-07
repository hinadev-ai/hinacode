# Shell integration for terminals

Status: Shipped
Date: 2026-11-07

## Problem

HinaCode knows nothing about what runs inside a drawer terminal. A tab reads `Terminal 2` whether it holds an idle prompt or the dev server, closing it kills whatever runs there without a word, and `session.cwd` is the folder the shell started in, stale after the first `cd`. An agent that reads a terminal with `read_terminal` has to guess from the text whether the last command passed.

Guessing from the process table (polling `ps` for the shell's children) needs a loop per terminal and still cannot tell the command line the user typed or its exit code. The shell knows all of it, so we ask the shell.

## User flow

1. The developer opens a terminal and runs `pnpm dev`. The tab reads `Terminal 1 pnpm dev`, the command in muted monospace and truncated.
2. They click the tab's close button. A dialog asks `Close Terminal 1?` and says `pnpm dev is still running. Closing the terminal stops it.` Cancel keeps it; Close terminal ends it. A terminal sitting at its prompt closes without asking, as before.
3. They press Ctrl+C. The command leaves the tab.
4. An agent calls `list_terminals`. Each status reads `running \`pnpm dev\``, `idle, the last command exited with code 130`, or `exited with code N`once the shell itself ended, and`cwd` is the shell's current folder.

## Design

- `services/shellIntegration/` holds one script per shell, imported with `?raw` and written to a temp folder once per `Terminals` layer, removed with it. `integratedLaunch` picks by the shell's basename:
  - zsh: `ZDOTDIR` points at our folder, whose `.zshenv` restores the user's `ZDOTDIR` (passed as `HINACODE_USER_ZDOTDIR`, or unset), sources the user's `.zshenv`, then adds a `precmd` hook first in `precmd_functions` so it sees the command's `$?`, and a `preexec` hook. zsh then reads the user's `.zprofile`, `.zshrc` and `.zlogin` from their own `ZDOTDIR` as usual.
  - bash: `--init-file`, which replaces `-l`, so the script sources `/etc/profile` and the first of `~/.bash_profile`, `~/.bash_login`, `~/.profile` the way a login shell does, then prepends a function to `PROMPT_COMMAND` (string or array) and puts `$(__hinacode_preexec)` at the front of `PS0`. `PS0` needs bash 4.4; older bash (macOS's `/bin/bash` 3.2) reports the cwd only.
  - fish: `--init-command` sources the hooks after the user's config, on the `fish_prompt`, `fish_preexec` and `fish_postexec` events. fish 4 also prints its own OSC 133 marks with `cmdline_url=`, which `ShellMarks` reads too.
  - Any other shell, and PowerShell on Windows, starts unchanged.
- Each hook prints standard marks: `OSC 133;A` at the prompt, `OSC 633;E;<line>` then `OSC 133;C` when a command starts (control characters in the line become spaces), `OSC 133;D;<code>` when it ends, and `OSC 7;file://<host><cwd>`. The cwd is not URL-encoded, so `ShellMarks` takes the path as written.
- `ShellMarks` (`services/shellMarks.ts`) runs on every PTY chunk in `Terminals.buffer`, before the scrollback. It keeps a mark split across chunks (at most 8 KiB) for the next one. `C` sets `command` (empty when the line is unknown), `D` clears it and sets `lastExitCode` only if a command was running, so the `D` a prompt prints after an empty line changes nothing. When `cwd`, `command` or `lastExitCode` change, `Terminals` updates the session and pushes `terminal.updated { session }`.
- `TerminalSession` gains `command` and `lastExitCode`, both null by default so an older server's sessions still decode. The renderer store replaces the session on `terminal.updated` and on every attach. The drawer tab shows `command`, and its close button opens `CloseRunningDialog` while `command` is not null.
- `terminalText` drops every OSC sequence before `stripVTControlCharacters`, which leaves the text of one with a space in it, so `read_terminal` never shows a command mark.
- The marks stay in the output. The renderer's terminal and any other terminal ignore OSC codes they do not know.

Nothing new crosses a trust boundary: the marks come from the user's own shell, and a program that prints fake marks can only change the label and status of its own terminal.

## Out of scope

- Detecting a running command in shells without integration. Their sessions keep `command` null, so close does not ask.
- Restoring terminals and their scrollback after a restart, and rerunning their last command. The command marks are the base for it.
- Per-command output ranges for `read_terminal`, such as reading only the output of the last command.
- The phone. apps/mobile ignores `terminal.updated`.

## Verification

- With `verify-hinacode`: open a terminal in a thread, run `cd /tmp; sleep 120`, check that the tab shows the command, that closing asks and Cancel keeps it, that `list_terminals` reports it running, then press Ctrl+C and check that the tab clears, `list_terminals` reports `idle, the last command exited with code 130` with `cwd: /tmp`, and closing no longer asks.
- Tests: `shellMarks.test.ts` (marks, split chunks, fish's `cmdline_url`, an empty line's `D`), `shellIntegration.integration.test.ts` (zsh, bash and fish when installed, each after the user's own startup file), the bash case in `Terminals.integration.test.ts` (the `terminal.updated` pushes and `cwd`), and the OSC case in `terminalText.test.ts`.
