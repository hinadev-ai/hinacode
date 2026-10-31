# Chat with Codex

The same chat surface as Claude Code, backed by the Codex app-server. The thread's `Access` decides the sandbox: the default `Full access` runs `danger-full-access` and never asks, `Auto` runs sandboxed and asks to go beyond it, and `Supervised` asks before any command that is not read-only. Under `Auto` or `Supervised`, every call to hinacode's own MCP tools also asks, through MCP elicitation. Every step costs a real Codex turn.

## Automated coverage

No e2e scenario drives Codex. `src/main/agents/codex/index.integration.test.ts` runs the provider against a fake app-server (`fakeAppServer.mjs`): the app-server log, fork, auto-compact, conversation mode, Stop during startup and on a running turn, token usage and the plan. The recipes below cover the UI.

## Sub-features

- `send` and `stream` as in `chat-claude.md`, with the provider label `Codex`.
- `agent-pick` switches a thread to Codex whenever no turn runs: the composer's `Model` combobox lists every agent's models, and picking one under `Codex` switches the agent. Effort and fast mode come from the saved defaults for Codex.
- `model-pick` lists Codex's live models in the composer `Model` combobox.
- `skills` typing `$` in `Message` opens the `Commands` listbox with Codex skills.
- `file-change` shows file edits as rows; changes inside the workspace need no approval.
- `mcp-approval` under `Auto`, shows `Codex needs your approval` when Codex calls a hinacode MCP tool; `Allow` runs it, `Deny` rejects it.
- `interrupt` stops a running turn; cut-off tool rows end `Failed` with output `Turn interrupted`.
- `restore` and `resume` after a relaunch.

## How to get to it (user POV)

- `New thread in <project>` or `Ctrl+N`, then pick a model under `Codex` in the composer's `Model`. While a turn runs `Model` lists only Codex models.
- Then the composer as in `chat-claude.md`.

## Driving it with agent-browser

Preconditions:

- Instance launched and doctor passes; project `demo` on `$DATA/repo`.
- The `codex` CLI is logged in (`codex --version` works for this user).
- `AB="agent-browser --session kkv-$PORT-chat-codex"`, connected.

- **Create.** Click `New thread in demo` (`--exact`), `$AB wait '[role=combobox][aria-label=Message]'`, and read the id from `threads.list`. Switch the agent: `$AB find role combobox click --name "Model" --exact`, `$AB wait '[role=option]'`, then click the first option under the `Codex` group (`$AB find role option click --name "<model>" --exact`). The header shows `Codex`, and `Model` shows that model with the Codex icon. Screenshot `chat-codex-01-new-thread.png`. `threads.list` shows `"provider": "codex"` for the thread.
- **Skills.** Type `$` into `Message` (`$AB focus '[role=combobox][aria-label=Message]'`, `$AB keyboard type '$'`). `$AB wait '[role=listbox][aria-label=Commands]'`; it lists Codex skills. With no skills installed no listbox opens; report that. `Escape` closes it. Clear the box.
- **Send and stream.** Fill `Message` with `Reply with the single word: pong`, press `Enter`. Screenshot `chat-codex-02-streaming.png` while `Running`; `$AB wait --text "pong"`; screenshot `chat-codex-03-reply.png`.
- **File change.** Send `Create a file hello.txt containing hi`. A file change row for `hello.txt` appears without an approval card, and `cat $DATA/repo/hello.txt` prints `hi`. Screenshot `chat-codex-04-file-change.png`.
- **MCP approval.** Set `Access` to `Auto`. Send `Call the hinacode MCP tool list_thread_pull_requests and tell me what it returns.` `$AB wait --text "Codex needs your approval"`; the card names the tool. Screenshot `chat-codex-05-mcp-approval.png`. Click `Allow` (`--exact`). The tool row turns `Done` and the reply says no pull requests are linked.
- **Interrupt.** Send `Run the shell command: python3 -c 'import time; time.sleep(60)'`, wait for the command row `Running`, click `Stop`. The command row ends `Failed` with output `Turn interrupted` and the header returns to `Idle`. Screenshot `chat-codex-06-interrupted.png`.
- **Restore and resume.** `stop.sh`, `launch.sh --no-build`, reconnect, open the thread, whose current title `threads.list` gives by id. History is intact (`chat-codex-07-restored.png`). Send `What single word did you reply with first?` and expect `pong` (`chat-codex-08-resumed.png`).

## Gotchas

- Without `Allow`, the MCP elicitation blocks the turn; leaving the thread or stopping the app cancels it and Codex reports the tool call as cancelled.
- Approval cards for shell commands only appear under `Auto` or `Supervised` when Codex asks to escalate. A plain `echo` inside the repo usually runs without one; do not count its absence as a bug.
- The model list comes from `codex` at runtime. If it fails, the `Model` combobox only shows the stored id; report that instead of guessing an id.
- A rename before the first send is overwritten by the automatic naming. Track the thread by id.
- Codex sessions persist in `~/.codex/sessions/` and are not removed by cleanup.
