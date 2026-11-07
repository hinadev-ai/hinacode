# Chat with Claude Code

A user sends a prompt in a Claude Code thread and watches the reply stream in, with tool calls shown as rows, permission requests shown as an approval card, a Stop button that interrupts the turn, and the conversation restored and resumable after the app restarts. The manual turns below use a real Claude account.

## Automated coverage

`e2e/features/limited-threads.feature` covers the Limited sidebar and header state, callouts in both locales (default theme only), persistence, one automatic retry after reset, cancellation, manual retry, and the organization spend limit with `Resume at reset`. It runs through the production mapper and runner without using a Claude account. `e2e/features/composer-skills.feature` covers the `/` list, skill chips and Claude Code's own commands; `e2e/features/responsive-composer.feature` (`The composer toolbar stays on one line and keeps every option reachable`) covers the toolbar at narrow widths; `e2e/features/worked-for.feature` covers the `Worked for` fold. `agent-activity.feature`, `agent-todos.feature`, `streaming-markdown.feature`, `queued-messages.feature` and `notifications.feature` run on the Claude mock too.

For a manual simulation, launch with `HINACODE_MOCK_CLAUDE=usage-limit` and an isolated `HINACODE_USER_DATA`. The first send reaches the limit, and the next attempt succeeds. Set `HINACODE_MOCK_RESET_MS=5000` for a five-second reset. `HINACODE_MOCK_CLAUDE=org-spend-limit` reproduces the organization cap, including its misleading session-reset text, and offers `Resume at reset`. `HINACODE_MOCK_CLAUDE=markdown` (or `pnpm dev:markdown`) answers every send with `src/main/agents/claude/fixtures/markdown.md`, which covers each Markdown construct the transcript renders. `docs/operations/mock-claude.md` lists the other scenarios. In a mock instance, sending `/mock-<scenario>` runs that scenario for one turn, so one instance shows every transcript state. The mock also disables model-based thread naming. `HINACODE_MOCK_AGENTS=<scenario>` serves Codex and Muse threads from the same simulation, so no real agent starts.

## Sub-features

- `send` sends a prompt with `Enter` or the `Send` button.
- `stream` renders `Thinking…`, then `Writing…` and assistant text incrementally while the submit button reads `Stop` and the sidebar row shows `Running`. There is no status in the thread header.
- `tool-rows` shows each tool call with its status (`Running`, `Done`, `Failed`); Bash rows expand to `Command` / `Output`. Once the turn ends its rows fold behind a `Worked for <duration>` button (e2e).
- `approval` under `Supervised` access shows `Claude Code needs your approval` with `Allow`, `Allow for session`, `Deny` for Bash and edits, a `Note for the agent` field (Enter denies with the note), and the sidebar status `Awaiting approval`.
- `interrupt` stops a running turn from `Stop` or `Ctrl+Shift+C`.
- `model-switch` changes the model for the next turn from the `Model: <summary>` picker (`Ctrl+Alt+M`).
- `effort-fast` the picker's `Effort` slider (`input[type=range]`, `Default (<x>)` then the model's efforts) and `Fast` toggle (`aria-pressed`), shown only when the model supports them. The picker also has `Conversation`.
- `turn-changes` a turn that edits files ends with a card (`Created note.txt`) with `Undo` and `View changes`.
- `completions` typing `/` lists Claude commands and skills (`Commands`, e2e), `@` lists files and threads (`Mentions`), `#` lists pull requests (`Pull requests`), in a listbox above the composer; ArrowUp/ArrowDown move, `Enter` or `Tab` inserts, `Escape` closes.
- `restore` shows the full history after a relaunch.
- `resume` continues the same Claude session after a relaunch, with earlier context intact.

## How to get to it (user POV)

- Open a thread whose agent is `Claude Code` from the sidebar, type in the `Message` box (role combobox), press `Enter` or click `Send`.
- While a turn runs, the submit button reads `Stop`, or `Queue` with a draft, or `Steer` while Cmd/Ctrl is held (see `steering-and-attachments.md`).
- Access in the picker: `Supervised`, `Auto`, `Full access` (the default, which never asks).
- `Ctrl+Shift+C` interrupts, `Ctrl+L` focuses the composer.

## Driving it with agent-browser

Preconditions:

- Instance launched and doctor passes; `$S/seed-repo.sh $DATA/repo` done.
- A project `demo` on `$DATA/repo` and a thread `claude chat` with agent `Claude Code` and model `Sonnet 5.5`, created through the UI as in `projects-and-threads.md` (new thread, rename, pick `Sonnet 5.5`), or seeded with `$S/rpc.ts $PORT threads.create '{"projectId":"<id>"}'`, then `$S/rpc.ts $PORT threads.update '{"id":"<thread id>","title":"claude chat","model":"claude-sonnet-5-5"}'`, then `ab reload`. The first send renames the thread, so find it afterwards by id or by the new `h1`, not by `claude chat`.
- The `claude` CLI is logged in (`claude --version` works for this user).
- `ab() { agent-browser --session kkv-$PORT-chat-claude --cdp $PORT "$@"; }`, thread open.

- **Completions (no turn).** Focus `Message` (`ab focus '[role=combobox][aria-label=Message]'`) and `ab keyboard type '@READ'`. `ab wait '[role=listbox][aria-label=Mentions]'`; it lists `README.md`. Press `Enter`; the box reads `@README.md `. Clear it, type `/`, `ab wait '[role=listbox][aria-label=Commands]'`, press `ArrowDown` (the `aria-selected` option moves), then `Escape`; the listbox closes and the text stays. Screenshot `chat-claude-00-completions.png` while a listbox is open. Clear the box.
- **Picker.** `ab click 'button[aria-label^="Model: "]'`, `ab wait '[role=listbox][aria-label=Model]'`, `ab find role option click --name "Sonnet 5.5" --exact`, `ab find role button click --name "Supervised" --exact`. If the model has efforts, `ab focus 'input[type=range]'` and `ab press ArrowRight`. If `Fast` is shown, click it; `aria-pressed` turns `true`. `ab press Enter` closes the popover; `ab get attr 'button[aria-label^="Model: "]' aria-label` and `threads.list` show the choice. Report a control as not shown when the model lacks it, not as a failure.
- **Send and stream.** `ab find role combobox fill --name "Message" "Reply with only the number 6 times 7."` and `ab press Enter`. `ab wait 'button[aria-label="Stop"]'` and take `chat-claude-01-streaming.png`. `ab wait --fn '!document.querySelector("button[aria-label=Stop]")'`; the reply reads `42`. Screenshot `chat-claude-02-reply.png`.
- **Approval.** With `Supervised` picked, send `Use the Bash tool to run: echo hina > note.txt, then reply with one word.` `ab wait --text "Allow" --timeout 90000`. The card reads `Claude Code needs your approval`, `Bash` and the command; the sidebar row shows `Awaiting approval`. Screenshot `chat-claude-03-approval.png`. `ab find role button click --name "Allow" --exact`. The Bash row turns `Done`, the turn ends with `Created note.txt` / `Undo` / `View changes`, and `note.txt` holds `hina` in the thread's workspace.
- **Deny.** Send `Use the Bash tool to run: rm README.md`, wait for the card, click `Deny`. The row ends `Failed` or the reply says it was denied, and `$DATA/repo/README.md` still exists.
- **Interrupt.** Send `Use the Bash tool to run in the foreground: python3 -c 'import time; time.sleep(120)'` (the CLI refuses a bare foreground `sleep`), `Allow` it if asked, wait until the tool row reads `Running`, then `ab find role button click --name "Stop" --exact` (or `ab press Control+Shift+C`). Within a few seconds `Stop` disappears, the cut-off Bash row ends `Failed`, and the reply ends with `**Error:** Turn interrupted`. Screenshot `chat-claude-04-interrupted.png`.
- **Side effects.** `$S/rpc.ts $PORT threads.transcript '{"threadId":"<id>"}' > "$SHOTS/chat-claude-05-messages.txt"` contains the user prompts, the assistant text `42`, and tool parts for the Bash calls.
- **Restore and resume.** `$S/stop.sh $DATA`, `$S/launch.sh $PORT $DATA --no-build`, `ab set viewport 1600 1000`, open the thread. All earlier messages and tool rows are present. Screenshot `chat-claude-06-restored.png`. Send `Which file did you create earlier? Reply with the filename only.` The answer is `note.txt`, proving the session resumed. Screenshot `chat-claude-07-resumed.png`.

## Gotchas

- Every send costs money. Keep prompts to one sentence on `Sonnet 5.5`, and do not loop on a failing step: capture the failure and stop.
- Reads inside the project are allowed without approval; Bash and file edits ask. Prompts must name the Bash tool explicitly or Claude may answer without running anything.
- The CLI rejects a standalone `sleep N`; keep a command busy with `python3 -c 'import time; time.sleep(N)'`.
- After a steer, Stop did not interrupt a running Bash command in the 2026-10-29 run; see `steering-and-attachments.md`.
- `Message` is a `combobox`, not a `textbox`. `find role textbox --name "Message"` finds nothing.
- `Enter` inserts the highlighted completion while a `Commands`, `Mentions` or `Pull requests` listbox is open instead of sending. Press `Escape` first when the text contains `/`, `$`, `@` or `#`.
- `ab wait --text` matches anywhere, including your own prompt: `wait --text "pong"` passes as soon as `Reply with the word pong` is sent. Wait for `Stop` to disappear, then read the transcript.
- A turn running when you call `stop.sh` is lost; the thread comes back idle. That is expected, not a resume failure.
- Claude transcripts persist in `~/.claude/projects/` and are not removed by cleanup.
