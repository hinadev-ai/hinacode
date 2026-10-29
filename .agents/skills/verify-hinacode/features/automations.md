# Automations

An automation starts a new thread from a prompt template when an event arrives: a signed webhook, a new GitHub issue (via `gh`), a new Linear issue, or a Slack mention. Templates use `{{path.to.field}}` placeholders filled from the event, and a run can get its own worktree. Settings > Automations creates, edits, enables, deletes and runs them, and shows recent runs. Every started run sends its prompt to an agent, so it costs a turn.

## Automated coverage

`e2e/features/automations.feature`: creating a webhook automation through the dialog and reading its one-time signing secret, a delivery with the wrong signature getting 401 `invalid_signature`, an unknown automation getting 404, and a disabled automation getting 409 `automation_disabled`. Nothing there starts a thread.

## Sub-features

- `create-webhook`, `webhook-rejects`, `toggle` (e2e).
- `webhook-signed` a correctly signed POST starts a thread: HTTP 202 with `runId` and `threadId`.
- `dedup` a repeated delivery id (`X-GitHub-Delivery`, else the body hash) records a `Skipped` run (HTTP 200, `skipped: true`) and starts nothing.
- `template` the thread's first prompt is the template rendered from `{ body, headers }`.
- `run-now` `Run now` with a `Sample payload` starts a run immediately, bypassing dedup.
- `worktree-run` with `Run in a new worktree`, each run gets a branch from `Branch template`.
- `pollers` GitHub, Linear and Slack triggers poll every 60 seconds (±10), the first within 10 seconds, and only start threads for items created after the automation was created or enabled; a poll error shows as one `Failed` run and is not recorded again while it repeats.
- `listener` the bind host and port of the webhook listener, applied on `Save`; a taken port shows `The listener is not running: <message>`.
- `delete` `Delete` with confirmation removes the automation and its runs.

## How to get to it (user POV)

- `Settings` > `Automations`: `New automation`, the per-row `Enable <name>` switch, `Runs and details`, `Edit`, `Delete`, the listener settings at the top.
- Senders POST to the webhook URL shown after creation and in `Runs and details` (`automations.webhookUrl`).

## Driving it with agent-browser, webhook.sh and rpc.ts

Preconditions:

- Instance launched and doctor passes, which includes `webhook listener on <40000+PORT> is ours`.
- Project `demo` on `$DATA/repo`; a webhook automation `hook check` with prompt `Reply with the word {{body.word}} only.` on `Sonnet 5.5`, created through the dialog with `Project` set to `demo` (it defaults to `Chats`). Read `SECRET` from the `hook check is ready` dialog and `URL` from `$S/rpc.ts $PORT automations.webhookUrl '{"id":"<id>"}'`.
- `AB="agent-browser --session kkv-$PORT-automations"`, connected.

- **Signed delivery.** `$S/webhook.sh "$URL" "$SECRET" '{"word":"ping"}' d1` prints 202 with a `threadId`. Without a reload the sidebar gains a thread in `demo` whose first message is `Reply with the word ping only.` and whose reply is `ping`. Screenshot `automations-01-thread-started.png`.
- **Dedup.** Repeat the same command with `d1`: 200 with `"skipped":true` and no new thread. `Runs and details` shows a `Skipped` run with `Already handled event d1`. Screenshot `automations-02-dedup.png`. `$S/rpc.ts $PORT automations.runs '{"id":"<id>","limit":10}' > "$SHOTS/automations-03-runs.txt"`.
- **Run now.** Open `Runs and details`, set `Sample payload` to `{"body":{"word":"manual"}}`, click `Run now`. A `Started` run and a thread with `Reply with the word manual only.` appear; `Open thread` opens it (scope it to the newest run, since every started run has one). Screenshot `automations-04-run-now.png`.
- **Worktree run.** Edit the automation: `Run in a new worktree` on, `Branch template` `kk/hook-{{body.word}}`. Deliver `{"word":"wt"}` with `d3`. The new thread's panel shows branch `kk/hook-wt` and `Ready`.
- **Listener port conflict.** Set the listener `Port` to a port another process holds and click `Save`. `Runs and details` shows `The listener is not running: ...EADDRINUSE...`. Set it back to `40000 + $PORT`.
- **Pollers.** Create a `GitHub issue` automation on a repo. To avoid a real repo, launch with a `gh` shim first on `PATH` that logs its arguments and answers `gh api repos/<repo>/issues?...` with one issue whose `created_at` is later than the automation's `cursor`. Within 10 to 70 seconds a run starts. Linear and Slack need real credentials; without them the first poll records one `Failed` run within about 15 seconds, and the next poll with the same error adds none.
- **Delete.** The row buttons are all named `Delete`, so scope to the row, then confirm in `Delete hook check?`. The row and its runs are gone, the webhook URL answers 404 `unknown_automation`, and threads it started stay.

## Gotchas

- Every started run costs an agent turn. Use Sonnet and one-word prompts, and disable or delete automations before leaving the instance running.
- The webhook template context is `{ body, headers }`, so placeholders start with `body.`. `Run now` uses the sample payload as the whole context, so wrap it as `{"body": ...}`.
- Without `X-GitHub-Delivery`, dedup keys on the body hash: resending the same body is skipped even with a new signature.
- The secret is only returned once. Losing it means creating a new automation.
- The cursor is set when the automation is created or enabled, not by the first poll, and re-enabling keeps it; issues created before that never start threads.
- `0.0.0.0` exposes the listener on the LAN and Tailscale. Keep `127.0.0.1` for verification.
