# Chat with Codex

The same chat surface as Claude Code, backed by the Codex app-server. The thread's `Access` decides the sandbox: the default `Full access` runs `danger-full-access` and never asks, `Auto` runs sandboxed and asks to go beyond it, and `Supervised` asks before any command that is not read-only. Under `Auto` or `Supervised`, every call to hinacode's own MCP tools also asks, through MCP elicitation. Every step costs a real Codex turn.

## Automated coverage

No e2e scenario drives Codex. `src/main/agents/codex/index.integration.test.ts` runs the provider against a fake app-server (`fakeAppServer.mjs`): the app-server log, fork, auto-compact, conversation mode, Stop during startup and on a running turn, token usage, the plan, sub-agents, background terminals, questions, accounts and limits, and session import. The recipes below cover the UI.

## Sub-features

- `send` and `stream` as in `chat-claude.md`, with the provider label `Codex`.
- `agent-pick` switches a thread to Codex whenever no turn runs: the `Model: <summary>` picker has agent tabs, and picking a model on the `Codex` tab switches the agent. On a started thread the transcript shows `Switched from Claude Code to Codex`. While a turn runs the other tabs are disabled.
- `model-pick` lists Codex's live models on the `Codex` tab, one button each.
- `skills` typing `$` in `Message` opens the `Commands` listbox with Codex skills.
- `file-change` shows file edits as rows; changes inside the workspace need no approval.
- `mcp-approval` under `Auto`, shows `Codex needs your approval` when Codex calls a hinacode MCP tool, with Codex's own message as the title and `MCP server hinacode` as the detail; `Allow` runs it, `Deny` rejects it. `Allow for session` sends the same accept as `Allow`.
- `interrupt` stops a running turn; cut-off tool rows end `Failed` and the reply ends with `**Error:** Turn interrupted`.
- `restore` and `resume` after a relaunch.

## How to get to it (user POV)

- `New thread in <project>` or `Ctrl+N`, then pick a model on the `Codex` tab of the `Model: <summary>` picker.
- Then the composer as in `chat-claude.md`.

## Driving it with agent-browser

Preconditions:

- Instance launched and doctor passes; project `demo` on `$DATA/repo`.
- The `codex` CLI is logged in (`codex --version` works for this user).
- `ab() { agent-browser --session kkv-$PORT-chat-codex --cdp $PORT "$@"; }`.

- **Create.** `ab find role button click --name "New thread in demo" --exact`, `ab wait '[role=combobox][aria-label=Message]'`. Switch the agent: `ab click 'button[aria-label^="Model: "]'`, `ab wait '[role=listbox][aria-label=Model]'`, `ab find role tab click --name "Codex" --exact`, `ab click '[role=option]'` (the first Codex model), `ab find role button click --name "Full access" --exact`, `ab press Enter`. `ab get attr 'button[aria-label^="Model: "]' aria-label` reads `Model: <model>, <effort>, Full access`. Screenshot `chat-codex-01-new-thread.png`. After the first send `threads.list` shows `"provider": "codex"`.
- **Skills.** Type `$` into `Message` (`ab focus '[role=combobox][aria-label=Message]'`, `ab keyboard type '$'`). `ab wait '[role=listbox][aria-label=Commands]'`; it lists Codex skills. With no skills installed no listbox opens; report that. `Escape` closes it. Clear the box.
- **Send and stream.** `ab find role combobox fill --name "Message" "Reply with only the number 6 times 7."`, `ab press Enter`, `ab wait 'button[aria-label="Stop"]'`, screenshot `chat-codex-02-streaming.png`; `ab wait --fn '!document.querySelector("button[aria-label=Stop]")' --timeout 120000`; the reply reads `42`. Screenshot `chat-codex-03-reply.png`.
- **File change.** Send `Create a file hello.txt containing hi`. A file change row for `hello.txt` appears without an approval card, and `cat $DATA/repo/hello.txt` prints `hi`. Screenshot `chat-codex-04-file-change.png`.
- **MCP approval.** Pick `Auto` in the picker. Send `Call the hinacode MCP tool list_thread_pull_requests and tell me what it returns.` `ab wait --text "Codex needs your approval"`. Screenshot `chat-codex-05-mcp-approval.png`. Click `Allow` (`--exact`). The tool row turns `Done` and the reply says no pull requests are linked.
- **Interrupt.** Send `Run the shell command: python3 -c 'import time; time.sleep(60)'`, wait for the command row `Running`, click `Stop`. The command row ends `Failed`, the reply ends with `**Error:** Turn interrupted`, and `Stop` disappears. Screenshot `chat-codex-06-interrupted.png`.
- **Restore and resume.** `stop.sh`, `launch.sh --no-build`, reconnect, open the thread, whose current title `threads.list` gives by id. History is intact (`chat-codex-07-restored.png`). Send `What number did you reply with first?` and expect `42` (`chat-codex-08-resumed.png`).

## Gotchas

- Without `Allow`, the MCP elicitation blocks the turn; leaving the thread or stopping the app cancels it and Codex reports the tool call as cancelled.
- Approval cards for shell commands only appear under `Auto` or `Supervised` when Codex asks to escalate. A plain `echo` inside the repo usually runs without one; do not count its absence as a bug.
- The model list comes from `codex` at runtime. If it fails, the `Codex` tab is empty and the picker shows only the stored id; report that instead of guessing an id.
- A rename before the first send is overwritten by the automatic naming. Track the thread by id.
- Codex sessions persist in `~/.codex/sessions/` and are not removed by cleanup.
