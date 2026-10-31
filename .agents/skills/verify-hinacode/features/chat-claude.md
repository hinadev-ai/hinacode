# Chat with Claude Code

A user sends a prompt in a Claude Code thread and watches the reply stream in, with tool calls shown as rows, permission requests shown as an approval card, a Stop button that interrupts the turn, and the conversation restored and resumable after the app restarts. The manual turns below use a real Claude account.

## Automated coverage

`e2e/features/limited-threads.feature` covers the Limited sidebar and header state, callouts in both locales (default theme only), persistence, one automatic retry after reset, cancellation, manual retry, and the organization spend limit with `Resume at reset`. It runs through the production mapper and runner without using a Claude account. `e2e/features/composer-skills.feature` covers the `/` list, skill chips and Claude Code's own commands; `e2e/features/responsive-composer.feature` (`The composer toolbar stays on one line and keeps every option reachable`) covers `More options`; `e2e/features/worked-for.feature` covers the `Worked for` fold.

For a manual simulation, launch with `HINACODE_MOCK_CLAUDE=usage-limit` and an isolated `HINACODE_USER_DATA`. The first send reaches the limit, and the next attempt succeeds. Set `HINACODE_MOCK_RESET_MS=5000` for a five-second reset. `HINACODE_MOCK_CLAUDE=org-spend-limit` reproduces the organization cap, including its misleading session-reset text, and offers `Resume at reset`. `HINACODE_MOCK_CLAUDE=markdown` (or `pnpm dev:markdown`) answers every send with `src/main/agents/claude/fixtures/markdown.md`, which covers each Markdown construct the transcript renders. `todos`, `stream`, `activity` and `approvals` are the other scenarios (`src/main/agents/claude/mock.ts`). The mock also disables model-based thread naming. `HINACODE_MOCK_AGENTS=<scenario>` serves Codex and Muse threads from the same simulation, so no real agent starts.

## Sub-features

- `send` sends a prompt with `Enter` or the `Send` button.
- `stream` renders `Thinking…`, then `Writing…` and assistant text incrementally while the header status reads `Running`.
- `tool-rows` shows each tool call with its status (`Running`, `Done`, `Failed`); Bash rows expand to `Command` / `Output`. Once the turn ends its rows fold behind a `Worked for <duration>` button (e2e).
- `approval` under `Supervised` access shows `Claude Code needs your approval` with `Allow`, `Allow for session`, `Deny` for Bash and edits, and the thread status `Awaiting approval`.
- `interrupt` stops a running turn from `Stop` or `Ctrl+Shift+C`.
- `model-switch` changes the model for the next turn from the composer `Model` select.
- `effort-fast` the composer `Effort` select and `Fast` toggle (`aria-pressed`), shown only when the model supports them; switching to a model without them resets them. A narrow composer drops their labels, then moves them into the `More options` menu.
- `completions` typing `/` lists Claude commands and skills (`Commands`, e2e), `@` lists files and threads (`Mentions`), `#` lists pull requests (`Pull requests`), in a listbox above the composer; ArrowUp/ArrowDown move, `Enter` or `Tab` inserts, `Escape` closes.
- `restore` shows the full history after a relaunch.
- `resume` continues the same Claude session after a relaunch, with earlier context intact.

## How to get to it (user POV)

- Open a thread whose agent is `Claude Code` from the sidebar, type in the `Message` box (role combobox), press `Enter` or click `Send`.
- While a turn runs, the composer shows `Stop`, `Queue` and `Steer` (see `steering-and-attachments.md`).
- `Access` in the composer: `Supervised`, `Auto`, `Full access` (the default, which never asks).
- `Ctrl+Shift+C` interrupts, `Ctrl+L` focuses the composer.

## Driving it with agent-browser

Preconditions:

- Instance launched and doctor passes; `$S/seed-repo.sh $DATA/repo` done.
- A project `demo` on `$DATA/repo` and a thread `claude chat` with agent `Claude Code` and model `Sonnet 5.5`, created through the UI as in `projects-and-threads.md` (new thread, rename, pick `Sonnet 5.5`), or seeded with `$S/rpc.ts $PORT threads.create '{"projectId":"<id>"}'`, then `$S/rpc.ts $PORT threads.update '{"id":"<thread id>","title":"claude chat","model":"claude-sonnet-5-5"}'`, then `$AB reload`. The first send renames the thread, so find it afterwards by id or by the new `h1`, not by `claude chat`.
- The `claude` CLI is logged in (`claude --version` works for this user).
- `AB="agent-browser --session kkv-$PORT-chat-claude"`, connected, thread open.

- **Completions (no turn).** Focus `Message` (`$AB focus '[role=combobox][aria-label=Message]'`) and `$AB keyboard type '@READ'`. `$AB wait '[role=listbox][aria-label=Mentions]'`; it lists `README.md`. Press `Enter`; the box reads `@README.md `. Clear it, type `/`, `$AB wait '[role=listbox][aria-label=Commands]'`, press `ArrowDown` (the `aria-selected` option moves), then `Escape`; the listbox closes and the text stays. Screenshot `chat-claude-00-completions.png` while a listbox is open. Clear the box.
- **Effort and fast.** If `Effort` is shown, pick a level with the keyboard (`$AB focus 'button[aria-label="Effort"]'`, `Enter`, `ArrowDown`, `Enter`); `threads.list` shows the thread's `effort`. If `Fast` is shown, click it; `aria-pressed` turns `true` and `threads.list` shows `"fastMode": true`. Report a control as not shown when the model lacks it, not as a failure.
- **Send and stream.** Run `$AB find role combobox fill --name "Message" "Reply with the single word: pong"` and `$AB press Enter`. Take `chat-claude-01-streaming.png` immediately: the header status reads `Running` and a `Thinking…` or partial reply is visible. `$AB wait --text "pong"`, then the header returns to `Idle`. Screenshot `chat-claude-02-reply.png`.
- **Approval.** Set `Access` to `Supervised` (or `$S/rpc.ts $PORT threads.update '{"id":"<id>","accessMode":"supervised"}'`). Send `Use the Bash tool to run: echo approved > approved.txt`. `$AB wait --text "Claude Code needs your approval"`. The card shows the command; the header reads `Awaiting approval`. Screenshot `chat-claude-03-approval.png`. Run `$AB find role button click --name "Allow" --exact`. The Bash tool row turns `Done`, and `cat $DATA/repo/approved.txt` prints `approved`.
- **Deny.** Send `Use the Bash tool to run: rm README.md`, wait for the card, click `Deny`. The row ends `Failed` or the reply says it was denied, and `$DATA/repo/README.md` still exists.
- **Interrupt.** Send `Use the Bash tool to run in the foreground: python3 -c 'import time; time.sleep(120)'` (the CLI refuses a bare foreground `sleep`), `Allow` it if asked, wait until the tool row reads `Running`, then `$AB find role button click --name "Stop" --exact` (or `$AB press Control+Shift+C`). Within a few seconds the header returns to `Idle` and the cut-off Bash row ends `Failed`. Screenshot `chat-claude-04-interrupted.png`.
- **Side effects.** `$S/rpc.ts $PORT threads.transcript '{"threadId":"<id>"}' > "$SHOTS/chat-claude-05-messages.txt"` contains the user prompts, the assistant text `pong`, and tool parts for the Bash calls.
- **Restore and resume.** `$S/stop.sh $DATA`, `$S/launch.sh $PORT $DATA --no-build`, `$AB connect $PORT`, open `claude chat`. All earlier messages and tool rows are present. Screenshot `chat-claude-06-restored.png`. Send `What single word did you reply with first?`. The answer is `pong`, proving the session resumed. Screenshot `chat-claude-07-resumed.png`.

## Gotchas

- Every send costs money. Keep prompts to one sentence on `Sonnet 5.5`, and do not loop on a failing step: capture the failure and stop.
- Reads inside the project are allowed without approval; Bash and file edits ask. Prompts must name the Bash tool explicitly or Claude may answer without running anything.
- The CLI rejects a standalone `sleep N`; keep a command busy with `python3 -c 'import time; time.sleep(N)'`.
- After a steer, Stop did not interrupt a running Bash command in the 2026-10-29 run; see `steering-and-attachments.md`.
- `Message` is a `combobox`, not a `textbox`. `find role textbox --name "Message"` finds nothing.
- `Enter` inserts the highlighted completion while a `Commands`, `Mentions` or `Pull requests` listbox is open instead of sending. Press `Escape` first when the text contains `/`, `$`, `@` or `#`.
- `$AB wait --text` matches anywhere, including your own prompt. Wait for text that only the reply contains, or for the header status.
- A turn running when you call `stop.sh` is lost; the thread comes back `Idle`. That is expected, not a resume failure.
- Claude transcripts persist in `~/.claude/projects/` and are not removed by cleanup.
