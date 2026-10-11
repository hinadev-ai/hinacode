# Automations

An automation starts a new thread from a prompt template when an event arrives: a signed webhook, a new GitHub issue (via `gh`), a new Linear issue, or a Slack mention. Templates use `{{path.to.field}}` placeholders filled from the event, and a run can get its own worktree. Settings > Automations creates, edits, enables, deletes and runs them, and shows recent runs. Every started run sends its prompt to an agent, so it costs a turn.

## Sub-features

- `create-webhook` creates a webhook automation and shows its URL and signing secret once (`<name> is ready`).
- `webhook-signed` a POST signed with HMAC-SHA256 of the raw body (`X-KKCODE-Signature` or `X-Hub-Signature-256`, `sha256=<hex>`) starts a thread: HTTP 202 with `runId` and `threadId`.
- `webhook-rejects` a bad signature gets 401 `invalid_signature`, an unknown id 404, a disabled automation 409.
- `dedup` a repeated delivery id (`X-GitHub-Delivery`, else the body hash) records a `Skipped` run (HTTP 200, `skipped: true`) and starts nothing; the run list shows `Already handled event <key>`.
- `template` the thread's first prompt is the template rendered from `{ body, headers }`.
- `run-now` `Run now` with a `Sample payload` starts a run immediately, bypassing dedup; the payload is the template context as is.
- `worktree-run` with `Run in a new worktree`, each run gets a branch from `Branch template`.
- `pollers` GitHub, Linear and Slack triggers poll every 60 seconds and only start threads for items created after the automation was enabled; poll errors show as `Failed` runs.
- `listener` the webhook listener's bind host (`This machine only` / `All interfaces`) and `Port`; a taken port shows `The listener is not running: <message>` in a webhook automation's `Runs and details`.
- `toggle-delete` `Enable <name>` switch and `Delete` with confirmation.

## How to get to it (user POV)

- `Settings` > `Automations`: `New automation`, the per-row `Enable <name>` switch, `Runs and details`, `Edit`, `Delete`, the listener settings at the top.
- Senders POST to the webhook URL shown after creation and in `Runs and details`.

## Driving it with agent-browser, webhook.sh and rpc.mjs

Preconditions:

- Instance launched and doctor passes, which includes `webhook listener on <40000+PORT> is ours` (launch.sh moved it off 48080).
- Project `demo` on `$DATA/repo`.
- `AB="agent-browser --session kkv-$PORT-automations"`, connected.

- **Create.** `Settings` > `Automations` > `New automation`. Name `hook check`, project `demo`, trigger `Webhook`, prompt template `Reply with the word {{body.word}} only.`, agent `Claude Code`, model `Sonnet 5.5`, worktree off, `Enabled` on. `Create automation`. The dialog `hook check is ready` shows `Webhook URL` and `Signing secret`. Screenshot `automations-01-secret.png`. Read the secret with `$AB snapshot` (it is shown only now), or create through `$S/rpc.mjs $PORT automations.create '<AutomationInput>'`, whose response carries `secret`, and say so. Get the URL any time with `$S/rpc.mjs $PORT automations.webhookUrl '{"id":"<id>"}'`.
- **Rejects.** `$S/webhook.sh "$URL" wrong '{"word":"ping"}' d1` prints 401 `invalid_signature`. Save to `automations-02-rejects.txt`.
- **Signed delivery.** `$S/webhook.sh "$URL" "$SECRET" '{"word":"ping"}' d1` prints 202 with a `threadId`. Without a reload the sidebar gains a thread in `demo` whose first message is `Reply with the word ping only.` and whose reply is `ping`. Screenshot `automations-03-thread-started.png`.
- **Dedup.** Repeat the same command with `d1`. It prints 200 with `"skipped":true` and no new thread appears. `Runs and details` shows a `Skipped` run with `Already handled event d1`. Screenshot `automations-04-dedup.png`. `$S/rpc.mjs $PORT automations.runs '{"id":"<id>","limit":10}' > "$SHOTS/automations-05-runs.txt"` lists one `started` and one `skipped` run.
- **Disabled.** Switch `Enable hook check` off, send with a new delivery id `d2`: 409 `automation_disabled`.
- **Run now.** Re-enable, open `Runs and details`, set `Sample payload` to `{"body":{"word":"manual"}}`, click `Run now`. A `Started` run and a new thread with `Reply with the word manual only.` appear; `Open thread` opens it. Screenshot `automations-06-run-now.png`.
- **Listener port conflict.** Set the listener `Port` to a port another process holds (for example `48080` when another kkcode runs). `Runs and details` of `hook check` shows `The listener is not running: ...` under the webhook URL. Set the port back to `40000 + $PORT`.
- **Pollers.** Create a `GitHub issue` automation on a repo. To avoid a real repo, put a `gh` shim first on `PATH` when launching (`PATH=$DATA/bin:$PATH $S/launch.sh ...`) that logs its arguments and answers `gh api repos/<repo>/issues?...` with a JSON array containing one issue whose `created_at` is later than the automation's `cursor`. Within 60 to 120 seconds a run starts. Linear and Slack need real credentials in `Integrations`; without them each poll records a `Failed` run with the error, which is the verifiable path.

## Gotchas

- Every started run costs an agent turn. Use Sonnet and one-word prompts, and disable or delete automations before leaving the instance running.
- The webhook template context is `{ body, headers }`, so placeholders start with `body.`. `Run now` uses the sample payload as the whole context, so wrap it as `{"body": ...}` to match.
- Without `X-GitHub-Delivery`, dedup keys on the body hash: resending the same body is skipped even with a new signature.
- The secret is only returned once. Losing it means creating a new automation.
- The first poll only sets the cursor; existing issues never start threads.
- `0.0.0.0` exposes the listener on the LAN and Tailscale. Keep `127.0.0.1` for verification.
