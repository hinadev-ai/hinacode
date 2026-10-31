# Chat with Muse Code

The same chat surface as Claude Code, backed by `muse serve` over MSP. Muse runs in its OS sandbox; the access picker sets its approval mode, live: `Ask me` edits the workspace freely and asks before protected writes and new network targets, `Auto-review` lets an AI review what would ask, and `Unrestricted` (the default `Full access`) runs with no sandbox or prompts. Every step costs a real Muse turn on the user's Meta login. `docs/muse-integration-guide.md` explains how the provider works.

## Automated coverage

No e2e scenario drives Muse. `src/main/agents/muse/index.integration.test.ts` runs the provider against the real `muse` binary and a fake model endpoint when `muse` is installed. It covers models and API keys, plan and rate limits, a text turn with usage, a two-stage approval allowed and denied, full access without asking, background shells, questions, sub-agents, Stop while streaming, compaction, token reading from logs and skills. The recipes below cover the UI.

## Sub-features

- `agent-pick` switches a thread to Muse Code by picking a model under the `Muse Code` group in the composer's `Model`, whenever no turn runs; the header and sidebar show the Meta logo.
- `model-pick` lists the plan's live models, such as `Muse Wonder Full 1.0`, without clipping; `effort-pick` lists `Minimal` to `Max`.
- `send` and `stream` as in `chat-claude.md`, with the provider label `Muse Code`.
- `approval` under `Ask me`, a command that reaches a new network host asks; `Allow` runs it.
- `deny` ends the command row in error, and the turn goes on.
- `interrupt` stops a running command; the row ends in error and the turn shows `Turn interrupted`.
- `usage` the thread's tokens and the plan limits, read with `threads.usage` and `limits.list` (the UI no longer shows them).
- `account` lists the CLI login as `Default` in Settings > Models, with no `Add account`.
- `restore` and `resume` after a relaunch.

## How to get to it (user POV)

- `New thread in <project>`, or `Ctrl+N` and a project in the palette, then pick a model under `Muse Code` in `Model`.
- `Access` in the composer: `Ask me`, `Auto-review`, `Unrestricted`.
- Settings > Models for the account and the default model.

## Driving it with agent-browser

Preconditions:

- Instance launched and doctor passes; project `demo` on `$DATA/repo`.
- `muse --version` works and `muse login` has been done for this user. `$S/rpc.ts $PORT agents.account '{"provider":"muse","accountId":null}'` answers `subscription`.
- `AB="agent-browser --session kkv-$PORT-chat-muse"`, connected.

- **Create.** Click `New thread in demo` (`--exact`). `$AB find role combobox click --name "Model" --exact`, `$AB wait '[role=option]'`, and pick `Muse Wonder Full 1.0` under `Muse Code`. The header shows `Muse Code`, and the list shows every model name in full. Screenshot `chat-muse-01-new-thread.png`. Set `Effort` to `Low`.
- **Send and stream.** Fill `Message` with `Reply with the single word: pong`, press `Enter`, `$AB wait --text "pong"`, then wait until the header leaves `Running`. Screenshot `chat-muse-02-reply.png`.
- **Usage.** `$S/rpc.ts $PORT threads.usage '{"threadId":"<id>"}'` names the model and its tokens; `$S/rpc.ts $PORT limits.list` shows the `muse` entry. Save both to `chat-muse-03-usage.txt`.
- **Approval.** Open `Access` and pick the option whose name starts with `Ask me` (the name includes its hint). Send `Run this exact shell command and nothing else: curl -sI https://example.org`. `$AB wait --text "needs your approval"`; screenshot `chat-muse-04-approval.png`. Click `Allow`. The Bash row prints the response headers. Screenshot `chat-muse-05-approved.png`.
- **Deny.** Still `Ask me`, send the same with a host not used yet, such as `https://example.net`. Click `Deny`. The row ends in error, with the reason Muse reports, and the turn goes on.
- **Interrupt.** In `Unrestricted`, send `Run this exact shell command and nothing else: python3 -c 'import time; time.sleep(120)'`, wait for the `Bash` row, click `Stop`. Screenshot `chat-muse-06-interrupted.png`.
- **Account.** In Settings > Models, the Muse Code section lists a `Default` row whose `Muse Code account` output reads `Signed in as …` (mask the email), a default model select, and no `Add account`. Screenshot `chat-muse-07-settings.png`.
- **Restore and resume.** `stop.sh`, `launch.sh --no-build`, reconnect with `--cdp $PORT`, and open the thread. History is intact. Send another command; it resumes the same Muse session.

## Gotchas

- A Muse turn stays `Running` for 20 to 40 seconds after its reply while Muse's reminder agents check the work. Wait for the header to leave `Running`, not for the text.
- The access options' accessible names include their hints, such as `Ask me Edits the workspace freely; asks before protected writes and new network targets`.
- Under `Ask me`, workspace commands such as `echo a && echo b` or `touch x` run without asking. Only a new network host or a protected write asks, so use a host the session has not reached yet.
- Tooltips and Settings show the signed-in email. Mask it before a screenshot leaves the machine.
- Muse sessions persist in `~/.local/share/muse/sessions/` and are not removed by cleanup.
