# Chat with Codex

The same chat surface as Claude Code, backed by the Codex app-server. Codex runs sandboxed (`workspace-write`, approvals `on-request`), so the approval card appears for escalations and for every call to hinacode's own MCP tools, which Codex gates through MCP elicitation. Every step costs a real Codex turn.

## Sub-features

- `send` and `stream` as in `chat-claude.md`, with the provider label `Codex`.
- `agent-pick` switches a new thread to Codex before the first message: the composer's `Model` combobox lists every agent's models, and picking one under `Codex` switches the agent. Effort and fast mode reset to Codex's defaults.
- `model-pick` lists Codex's live models in the composer `Model` combobox.
- `skills` typing `$` in `Message` opens the `Commands` listbox with Codex skills.
- `file-change` shows file edits as rows; changes inside the workspace need no approval.
- `mcp-approval` shows `Codex needs your approval` when Codex calls a hinacode MCP tool; `Allow` runs it, `Deny` rejects it.
- `interrupt` stops a running turn; cut-off tool rows end `Failed` with output `Turn interrupted`.
- `restore` and `resume` after a relaunch.

## How to get to it (user POV)

- `New thread in <project>` or `Ctrl+N`, then pick a model under `Codex` in the composer's `Model`. After the first message `Model` lists only Codex models.
- Then the composer as in `chat-claude.md`.

## Driving it with agent-browser

Preconditions:

- Instance launched and doctor passes; project `demo` on `$DATA/repo`.
- The `codex` CLI is logged in (`codex --version` works for this user).
- `AB="agent-browser --session kkv-$PORT-chat-codex"`, connected.

- **Create.** Click `New thread in demo` (`--exact`), `$AB wait 'textarea[aria-label=Message]'`. Rename the thread `codex chat` from `Actions for <placeholder>` as in `projects-and-threads.md`. Switch the agent: `$AB find role combobox click --name "Model" --exact`, `$AB wait '[role=option]'`, then click the first option under the `Codex` group (`$AB find role option click --name "<model>" --exact`). The header shows `Codex`, and `Model` shows that model with the Codex icon. Screenshot `chat-codex-01-new-thread.png`. `threads.list` shows `"provider": "codex"` for the thread.
- **Skills.** Type `$` into `Message` (`$AB focus 'textarea[aria-label=Message]'`, `$AB keyboard type '$'`). `$AB wait '[role=listbox][aria-label=Commands]'`; it lists Codex skills (it may be empty if none are installed; report that). `Escape` closes it. Clear the box.
- **Send and stream.** Fill `Message` with `Reply with the single word: pong`, press `Enter`. Screenshot `chat-codex-02-streaming.png` while `Running`; `$AB wait --text "pong"`; screenshot `chat-codex-03-reply.png`.
- **File change.** Send `Create a file hello.txt containing hi`. A file change row for `hello.txt` appears without an approval card, and `cat $DATA/repo/hello.txt` prints `hi`. Screenshot `chat-codex-04-file-change.png`.
- **MCP approval.** Send `Call the hinacode MCP tool list_thread_pull_requests and tell me what it returns.` `$AB wait --text "Codex needs your approval"`; the card names the tool. Screenshot `chat-codex-05-mcp-approval.png`. Click `Allow` (`--exact`). The tool row turns `Done` and the reply says no pull requests are linked.
- **Interrupt.** Send `Run the shell command: sleep 60`, wait for the command row `Running`, click `Stop`. The command row ends `Failed` with output `Turn interrupted` and the header returns to `Idle`. Screenshot `chat-codex-06-interrupted.png`.
- **Restore and resume.** `stop.sh`, `launch.sh --no-build`, reconnect, open `codex chat`. History is intact (`chat-codex-07-restored.png`). Send `What single word did you reply with first?` and expect `pong` (`chat-codex-08-resumed.png`).

## Gotchas

- Without `Allow`, the MCP elicitation blocks the turn; leaving the thread or stopping the app cancels it and Codex reports the tool call as cancelled.
- Approval cards for shell commands only appear when Codex asks to escalate out of the sandbox. A plain `echo` inside the repo usually runs without one; do not count its absence as a bug.
- The model list comes from `codex` at runtime. If it fails, the `Model` combobox only shows the stored id; report that instead of guessing an id.
- After the first message `Model` lists only the thread's agent, and `threads.update` with a new `provider` fails.
- Codex sessions persist in `~/.codex/sessions/` and are not removed by cleanup.
