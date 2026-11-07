# Chat with Muse Code

The same chat surface as Claude Code, backed by `muse serve` over MSP. Muse runs in its OS sandbox; the access picker sets its approval mode, live: `Ask me` edits the workspace freely and asks before protected writes and new network targets, `Auto-review` lets an AI review what would ask, and `Unrestricted` (Muse's label for the default `Full access`) runs with no sandbox or prompts. Every step costs a real Muse turn on the user's Meta login. `docs/muse-integration-guide.md` explains how the provider works.

## Automated coverage

No e2e scenario drives Muse. `src/main/agents/muse/index.integration.test.ts` runs the provider against the real `muse` binary and a fake model endpoint when `muse` is installed. It covers models and API keys, plan and rate limits, a text turn with usage, a two-stage approval allowed and denied, full access without asking, background shells, questions, sub-agents, Stop while streaming, compaction, token reading from logs and skills. The recipes below cover the UI.

## Sub-features

- `agent-pick` switches a thread to Muse Code by picking a model on the `Muse Code` tab of the `Model: <summary>` picker, whenever no turn runs; the header and sidebar show the Meta logo. The Access buttons switch to Muse's labels only after a Muse model is picked.
- `model-pick` lists the plan's live models, such as `Muse Wonder 1.0` and `Muse Wonder Full 1.0`, a second after the tab opens; `effort-pick` is the `Effort` slider, `Default (High)` then `Minimal` to `Max`. Muse has no `Fast` and no `Conversation`.
- `send` and `stream` as in `chat-claude.md`, with the provider label `Muse Code`.
- `approval` under `Ask me`, a command that reaches a new network host asks; `Allow` runs it.
- `deny` ends the command row in error, and the turn goes on.
- `interrupt` stops a running command; the row ends in error and the turn shows `Turn interrupted`.
- `usage` the composer's context ring shows the thread's context tokens; `threads.usage` (`{models, transcripts}`) and `limits.list` give the rest.
- `account` lists the CLI login as `Default` in Settings > Providers, with no `Add account`.
- `restore` and `resume` after a relaunch.

## How to get to it (user POV)

- `New thread in <project>`, or `Ctrl+N` and a project in the palette, then pick a model on the `Muse Code` tab of the picker.
- Access in the picker: `Ask me`, `Auto-review`, `Unrestricted`.
- Settings > Providers for the account and the default model.

## Driving it with agent-browser

Preconditions:

- Instance launched and doctor passes; project `demo` on `$DATA/repo`.
- `muse --version` works and `muse login` has been done for this user. `$S/rpc.ts $PORT agents.account '{"provider":"muse","accountId":null}'` answers `subscription`.
- `ab() { agent-browser --session kkv-$PORT-chat-muse --cdp $PORT "$@"; }`.

- **Create.** `ab find role button click --name "New thread in demo" --exact`. `ab click 'button[aria-label^="Model: "]'`, `ab wait '[role=listbox][aria-label=Model]'`, `ab find role tab click --name "Muse Code" --exact`, `ab wait --text "Muse Wonder 1.0"`, `ab find role option click --name "Muse Wonder 1.0" --exact`. Then `ab focus 'input[type=range]'`, `ab press ArrowRight` twice; `ab get attr 'input[type=range]' aria-valuetext` reads `Low`. `ab press Enter`; the trigger reads `Model: Muse Wonder 1.0, Low, Unrestricted`. Screenshot `chat-muse-01-new-thread.png`.
- **Send and stream.** `ab find role combobox fill --name "Message" "Reply with only the number 6 times 7."`, `ab press Enter`, `ab wait 'button[aria-label="Stop"]'`, then `ab wait --fn '!document.querySelector("button[aria-label=Stop]")' --timeout 150000`. The reply reads `42`. Screenshot `chat-muse-02-reply.png`.
- **Usage.** `$S/rpc.ts $PORT threads.usage '{"threadId":"<id>"}'` names the model and its tokens; `$S/rpc.ts $PORT limits.list` shows the `muse` entry. Save both to `chat-muse-03-usage.txt`.
- **Approval.** In the picker click `Ask me`. Send `Run this exact shell command and nothing else: curl -sI https://example.org`. `ab wait --text "needs your approval"`; screenshot `chat-muse-04-approval.png`. Click `Allow`. The Bash row prints the response headers. Screenshot `chat-muse-05-approved.png`.
- **Deny.** Still `Ask me`, send the same with a host not used yet, such as `https://example.net`. Click `Deny`. The row ends in error, with the reason Muse reports, and the turn goes on.
- **Interrupt.** In `Unrestricted`, send `Run this exact shell command and nothing else: python3 -c 'import time; time.sleep(120)'`, wait for the `Bash` row, click `Stop`. Screenshot `chat-muse-06-interrupted.png`.
- **Account.** In Settings > Providers, the Muse Code section lists a `Default` row whose `Muse Code account` output reads `Signed in as …` (mask the email), a default model select, and no `Add account`. Screenshot `chat-muse-07-settings.png`.
- **Restore and resume.** `stop.sh`, `launch.sh --no-build`, `ab set viewport 1600 1000`, and open the thread. History is intact. Send another command; it resumes the same Muse session.

## Gotchas

- A Muse turn can stay running for 20 to 40 seconds after its reply while Muse's reminder agents check the work. Wait for `Stop` to disappear, not for the text.
- The Access buttons are named `Ask me`, `Auto-review` and `Unrestricted`; the selected one's hint is a separate line under the group.
- Under `Ask me`, workspace commands such as `echo a && echo b` or `touch x` run without asking. Only a new network host or a protected write asks, so use a host the session has not reached yet.
- Tooltips and Settings show the signed-in email. Mask it before a screenshot leaves the machine.
- Muse sessions persist in `~/.local/share/muse/sessions/` and are not removed by cleanup.
