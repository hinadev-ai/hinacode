# kkcode verification map

This directory is the maintained source for verifying what a kkcode user can do. Read this index, then use the matching feature file as the recipe. Launch, doctor, evidence and cleanup rules are in `../SKILL.md`.

## Baseline preconditions

- Variables from SKILL.md are set: `S`, `PORT`, `DATA`, `SHOTS`, `AB`.
- `$S/launch.sh $PORT $DATA` printed `kkcode ready` and `$S/doctor.sh $PORT $DATA` exits 0.
- `$S/seed-repo.sh $DATA/repo` created the scratch repo. Feature files call the project on it `demo` unless they say otherwise.
- `$AB connect $PORT` succeeded and the window shows the kkcode sidebar.
- Never drive an instance that this run did not launch.

## Driving conventions

- Start every recipe from a fresh profile unless its preconditions say otherwise. A second recipe in the same run may reuse the instance if its preconditions hold.
- Prefer roles and accessible names (`$AB find role button click --name "..." --exact`). Use CSS on ids or `aria-label` only when names are ambiguous, as the feature files note.
- Wait on UI state (`$AB wait '<css>'`, `$AB wait --text`, `$AB wait --fn`), not on fixed sleeps.
- Seed and read back with `$S/rpc.mjs`; perform the behavior under test through the window, the MCP endpoint, or the webhook endpoint.
- Agent turns cost money: `Sonnet 5.5` for Claude, the first listed model for Codex, one-sentence prompts.
- Run `$S/cleanup.sh $PORT $DATA <ab-session>` after every attempt. It never touches `$SHOTS`.

## Proof and skip reporting

- Screenshots go to `$SHOTS/<feature>-<NN>-<step>.png`, text artifacts to the same stem with `.txt`.
- Capture the action and the resulting state, plus a read-only second view for every mutation (rpc read-back, file on disk, relaunch).
- List each sub-feature as proven, failed (with the artifact), or skipped (with the reason and the unmet precondition). Do not report a sub-feature as proven through a different entry point than the one named.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then four H2 sections in this order: `Sub-features` (short IDs, one line each), `How to get to it (user POV)` (every entry point), `Driving it with <harness>` (starts with `Preconditions:`, then labeled bullets pairing an action, the exact command, and the observable result), and `Gotchas`.

## Features

- [Projects and threads](./projects-and-threads.md): add project, new thread, sidebar grouping, keyboard reorder, rename, settle, delete, persistence. No agent cost. Proven end to end when this skill was created.
- [Chat with Claude Code](./chat-claude.md): send, streaming, tool rows, approvals, interrupt, restore and resume after relaunch.
- [Chat with Codex](./chat-codex.md): the same on Codex, including MCP elicitation approvals for kkcode tools.
- [Worktrees](./worktrees.md): setup script with `$KKCODE_ROOT_PATH`, setup log, failure state, changes and diffs, settle cleanup. No agent cost.
- [Steering and attachments](./steering-and-attachments.md): steering a running turn on both agents, paste, drop and remove attachments.
- [MCP tools and pull request links](./mcp-and-pull-requests.md): tool contract and auth, `review_changes`, `link_pull_request` from inside a turn, panel links and unlink, Linear without a key.
- [Settings](./settings.md): language en and zh-TW, default models, keybinding recording, conflicts and reset, Linear and Slack secrets. No agent cost.
- [Ports](./ports.md): listing workspace listeners and the two-click kill. No agent cost.
- [Automations](./automations.md): signed webhook delivery, rejects, dedup, run now, listener port, pollers.
