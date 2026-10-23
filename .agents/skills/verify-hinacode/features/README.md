# hinacode verification map

This directory is the maintained source for verifying what a hinacode user can do. Read this index, then use the matching feature file as the recipe. Launch, doctor, evidence and cleanup rules are in `../SKILL.md`.

## Automated first

`pnpm test:e2e` runs the Gherkin scenarios in `e2e/features` against the built app. Every feature file below starts with the scenarios that already cover it; those sub-features are proven by a green run and are not driven by hand. The recipes that remain are the ones a test cannot own: real agent turns, tools called from inside a turn, GitHub through a real `gh`, automations that start threads, and native dialogs. When a recipe here turns out to be automatable, move it into `e2e/features` and delete it from the feature file.

## Baseline preconditions

- Variables from SKILL.md are set: `S`, `PORT`, `DATA`, `SHOTS`, `AB`.
- `$S/launch.sh $PORT $DATA` printed `hinacode ready` and `$S/doctor.sh $PORT $DATA` exits 0.
- `$S/seed-repo.sh $DATA/repo` created the scratch repo. Feature files call the project on it `demo` unless they say otherwise.
- `$AB connect $PORT` succeeded and the window shows the hinacode sidebar.
- Never drive an instance that this run did not launch.

## Driving conventions

- Start every recipe from a fresh profile unless its preconditions say otherwise. A second recipe in the same run may reuse the instance if its preconditions hold.
- Prefer roles and accessible names (`$AB find role button click --name "..." --exact`). Use CSS on ids or `aria-label` only when names are ambiguous, as the feature files note.
- Wait on UI state (`$AB wait '<css>'`, `$AB wait --text`, `$AB wait --fn`), not on fixed sleeps.
- Seed and read back with `$S/rpc.ts`; perform the behavior under test through the window, the MCP endpoint, or the webhook endpoint.
- Agent turns cost money: `Sonnet 5.5` for Claude, the first listed model for Codex, `Low` effort for Muse Code, one-sentence prompts.
- Run `$S/cleanup.sh $PORT $DATA <ab-session>` after every attempt. It never touches `$SHOTS`.

## Proof and skip reporting

- Screenshots go to `$SHOTS/<feature>-<NN>-<step>.png`, text artifacts to the same stem with `.txt`.
- Capture the action and the resulting state, plus a read-only second view for every mutation (rpc read-back, file on disk, relaunch).
- List each sub-feature as automated (name the scenario), proven, failed (with the artifact), or skipped (with the reason and the unmet precondition). Do not report a sub-feature as proven through a different entry point than the one named.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then these H2 sections in order: `Automated coverage` (the `e2e/features` scenarios and what they prove), `Sub-features` (short IDs, one line each, marked `e2e` when a scenario covers them), `How to get to it (user POV)` (every entry point), `Driving it with <harness>` (starts with `Preconditions:`, then labeled bullets pairing an action, the exact command, and the observable result, for the sub-features not marked `e2e`), and `Gotchas`.

## Features

- [Projects and threads](./projects-and-threads.md): fully automated except pointer-drag reorder and the native folder picker.
- [Chat with Claude Code](./chat-claude.md): send, streaming, tool rows, approvals, interrupt, restore and resume after relaunch. Real turns only.
- [Chat with Codex](./chat-codex.md): the same on Codex, including MCP elicitation approvals for hinacode tools. Real turns only.
- [Chat with Muse Code](./chat-muse.md): the same on Muse Code, with staged command approvals, token usage and plan limits. Real turns only.
- [Worktrees](./worktrees.md): setup services and panels automated; composer creation and branch naming need a real first turn, and the `PR <state>` badge needs a GitHub remote.
- [Steering and attachments](./steering-and-attachments.md): steering a running turn on both agents, paste, drop and remove attachments. Real turns only.
- [MCP tools and pull request links](./mcp-and-pull-requests.md): contract and panel automated; `link_pull_request` from inside a turn, `gh` status, creating a pull request, the `gh` sign-in states, `request_secret` cards and `create_thread` during actual agent turns by hand; the thread controls are automated.
- [Settings](./settings.md): automated except the Codex default model and the Slack token, which share code with the automated cases.
- [Ports](./ports.md): automated except a listener spawned by an agent.
- [Automations](./automations.md): creation and rejects automated; signed deliveries, dedup, run now, worktree runs, pollers and the listener port by hand, since each starts a thread.
