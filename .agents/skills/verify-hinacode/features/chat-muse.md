# Chat with Muse Code

The same chat surface as Claude Code, backed by `muse serve` over MSP. Muse runs in its OS sandbox with the network open; the access picker sets its approval mode, live. Every step costs a real Muse turn on the user's Meta login. `docs/muse-integration-guide.md` explains how the provider works.

## Automated coverage

No e2e scenario drives Muse. `src/main/agents/muse/index.integration.test.ts` runs the provider against the real `muse` binary and a fake model endpoint when `muse` is installed. It covers a text turn, a two-stage approval allowed and denied, a question, Stop and usage paging. The recipes below cover the UI.

## Sub-features

- `agent-pick` switches a new thread to Muse Code from the composer's `Agent` combobox before the first message; the header and sidebar show the Meta logo.
- `model-pick` lists the plan's live models, such as `Muse Wonder Full 1.0`, without clipping; `effort-pick` lists `Minimal` to `Max`.
- `send` and `stream` as in `chat-claude.md`, with the provider label `Muse Code`.
- `approval` in Supervised asks once for a compound command (`echo a && echo b`); `Allow` runs every stage.
- `deny` ends the command row in error with `approval aborted`, and the turn goes on.
- `interrupt` stops a running command; the row ends in error and the turn shows `Turn interrupted`.
- `usage` shows the thread's tokens in the status bar, with reminder agents counted as sub-agents.
- `limits` shows a Muse Code group with the 5-hour and weekly windows after the first turn since launch.
- `account` lists the CLI login in Settings > Models, with no `Add account`.
- `restore` and `resume` after a relaunch.

## How to get to it (user POV)

- `New thread in <project>` or `Ctrl+N`, then set `Agent` to `Muse Code` in the composer. `Agent` is gone after the first message.
- Settings > Models for the account and the default model.

## Driving it with agent-browser

Preconditions:

- Instance launched and doctor passes; project `demo` on `$DATA/repo`.
- `muse --version` works and `muse login` has been done for this user. `$S/rpc.mjs $PORT agents.account '{"provider":"muse","accountId":null}'` answers `subscription`.
- `AB="agent-browser --session kkv-$PORT-chat-muse"`, connected.

- **Create.** Click `New thread in demo` (`--exact`). `$AB focus 'button[aria-label="Agent"]'`, `$AB press Enter`, then `ArrowDown` twice and `Enter`. `Agent` reads `Muse Code` and the header shows `Muse Code`. Screenshot `chat-muse-01-new-thread.png`.
- **Model and effort.** Click the `Model` combobox; the list shows every model name in full. Pick `Muse Wonder Full 1.0`, then `Effort` `Low`. Screenshot `chat-muse-02-model-picker.png`.
- **Send and stream.** Fill `Message` with `Reply with the single word: pong`, press `Enter`, `$AB wait --text "pong"`, then wait until the header leaves `Running`. Screenshot `chat-muse-03-reply.png`.
- **Usage.** Hover `button[aria-label$="tokens spent by this thread"]`; the breakdown names the model and "Main session and N sub-agents". Screenshot `chat-muse-04-tokens.png`.
- **Limits.** Within two minutes of the first turn, `meter[aria-label="Muse Code plan limits"]` appears; hover it for the 5-hour and weekly rows. Screenshot `chat-muse-05-limits.png`. `$S/rpc.mjs $PORT limits.list` shows the `muse` entry.
- **Approval.** Open `Access` and pick the option named `Supervised Asks before commands and edits` (`--exact`). Send `Run this exact shell command and nothing else: echo stage-one && echo stage-two`. `$AB wait --text "needs your approval"`; screenshot `chat-muse-06-approval.png`. Click `Allow` once. The Bash row prints both lines. Screenshot `chat-muse-07-approved.png`.
- **Deny.** Still Supervised, send `Run this exact shell command and nothing else: touch denied.txt`. Click `Deny`. The row ends in error, and `ls $DATA/repo/denied.txt` fails.
- **Interrupt.** In Full access, send `Run this exact shell command and nothing else: sleep 120`, wait for the `Bash` row, click `Stop`. Screenshot `chat-muse-08-interrupted.png`.
- **Account.** In Settings > Models, the Muse Code section shows `CLI login` signed in, a default model select, and no `Add account`. Screenshot `chat-muse-09-settings.png`.
- **Restore and resume.** `stop.sh`, `launch.sh --no-build`, reconnect with `--cdp $PORT`, and open the thread. History is intact, and the token count is back without a new turn. Send another command; it resumes the same Muse session.

## Gotchas

- A Muse turn stays `Running` for 20 to 40 seconds after its reply while Muse's reminder agents check the work. Wait for the header to leave `Running`, not for the text.
- The access options' accessible names include their hints, such as `Supervised Asks before commands and edits`.
- The limits group needs a model call in the current host, so it is missing right after a relaunch until the next turn.
- Tooltips open on hover, not on focus.
- Tooltips and Settings show the signed-in email. Mask it before a screenshot leaves the machine.
- Muse sessions persist in `~/.local/share/muse/sessions/` and are not removed by cleanup.
