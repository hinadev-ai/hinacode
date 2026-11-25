# Routines

A routine runs a prompt as a new thread on a cron schedule, from a webhook call, or from `Run now`. Each machine owns its routines and runs them with its own scheduler and webhook listener. Settings > Routines lists the routines of every connected machine, grouped by machine. Every started run costs an agent turn.

## Automated coverage

`e2e/features/routines.feature`: creating a routine with an `Every day` schedule and reading its description and next run, disabling it clears the next run, `Run now` leaves a thread link in the run history, and the webhook answers 202 to the secret as a Bearer token and 401 to a wrong one.

## Sub-features

- `create`, `disable`, `run-now`, `webhook-bearer` (e2e).
- `schedule` an enabled routine with a schedule starts a thread at each slot. A slot missed while the app was closed fires once on launch, then the next future slot.
- `skill-prompt` the prompt field is the composer editor: `/` lists the project's skills and commands for the chosen agent, and the thread's first message is the prompt text, such as `/triage-issue the flaky login test`.
- `overlap` a scheduled slot is recorded as `Skipped` while the previous run's thread is running or waiting for a human.
- `auto-pause` three failed scheduled runs in a row disable the routine.
- `webhook-hmac` `X-Hub-Signature-256: sha256=<hmac of the body>` is accepted the same way as the Bearer token.
- `idempotency` a repeated `Idempotency-Key` or `X-GitHub-Delivery` records a `Skipped` run (HTTP 200, `skipped: true`).
- `payload` a non-empty webhook body is appended to the prompt as a fenced block.
- `worktree-run` with `Run in a new worktree`, each run gets its own worktree branched from the project's current branch.
- `inbox` a new run settles earlier runs of the same routine that nobody replied to, so Ready holds one row per routine.
- `run-history` the newest 200 runs, 20 at a time behind `Show N more`; skip reasons are muted, failures red.
- `cli` `hinacode routines ls | run | enable | disable` with an id or a 4+ character prefix.
- `listener` the bind host and port of the webhook listener; a taken port shows the listen error.
- `trigger` a routine with a GitHub trigger starts a thread from a signed delivery to `/hooks/github` by an allowed sender, and a later event on the same issue or pull request continues that thread.
- `linear-trigger` a routine with a Linear trigger starts a thread from a signed delivery to `/hooks/linear`: a comment on an issue by an allowed email in an allowed team, or an issue assigned to the API key's account. A later comment on the same issue continues that thread.

## How to get to it (user POV)

- `Settings` > `Routines`: `New routine`, the per-row `Enable <name>` switch, `Run <name> now`, `Actions for <name>` (Edit, Delete), and the row itself, which expands to the webhook URL, a curl example, `Create secret` or `Rotate secret`, and recent runs.
- The webhook secret is shared by every routine on a machine and shown once, in the `Webhook secret` dialog.

## Driving it with agent-browser, webhook.sh and rpc.ts

Preconditions:

- Instance launched with `HINACODE_MOCK_CLAUDE=markdown` so runs cost nothing, and doctor passes, which includes `webhook listener on <40000+PORT> is ours`.
- Project `demo` on `$DATA/repo`.
- `ab() { agent-browser --session kkv-$PORT-routines --cdp $PORT "$@"; }`.

Checks:

- **Scheduled run.** `New routine`, fill `Name`, pick `Project` `demo`, `Repeat` `Custom`, `Cron expression` `* * * * *`, type `/` in `Prompt` and pick a skill from listbox `Commands`, pick a `Model`, `Create routine`. `$S/rpc.ts $PORT routines.runs '{"id":"<id>","limit":5}'` shows a `schedule` run with a `threadId` within a minute, and `threads.transcript` on it shows the prompt. Disable it afterwards, or it starts a thread every minute.
- **Webhook.** Click the row, `Create secret`, read the secret from the dialog (`ab eval 'document.querySelector("[role=dialog]").innerText'`). `$S/webhook.sh "$URL" "$SECRET" '{"pr":42}' key-1` prints 202; the same command again prints 200 with `skipped`; add `--hmac` as the fifth argument to sign instead; a wrong secret prints 401 and a disabled routine 409.
- **Trigger.** `New routine`, tab `No schedule`, combobox `Trigger` `GitHub issue comment`, fill `From`, `Repositories` and `Contains`, `Create routine`. `Create routine` stays disabled while `From` is empty. Read `githubUrl` from `$S/rpc.ts $PORT routines.webhook '{"id":"<id>"}'` and post an `issue_comment` payload with `GITHUB_EVENT=issue_comment $S/webhook.sh "$URL" "$SECRET" "$BODY" "" --hmac`. An allowed sender in an allowed repository with the phrase gets 202 with one `started` run, the same comment id again gets a `skipped` run, and a second comment id on the same issue gets a `started` run with the same `threadId`. A stranger, another repository, a comment without the phrase, a `ping` and a comment that holds `<!-- hinacode -->` all get 202 with `"runs":[]`. A wrong secret gets 401. `threads.transcript` shows the event quoted as JSON under the routine prompt.
- **Linear trigger.** Launch with `HINACODE_MOCK_LINEAR=1`. Store the signing secret with `$S/rpc.ts $PORT secrets.set '{"name":"linear.webhookSecret","value":"lin_wh_test"}'`. Create a routine whose trigger is `linear.comment` from `ada@acme.dev` in team `ENG`, read `linearUrl` from `routines.webhook`, and post a comment with `LINEAR_EVENT=Comment $S/webhook.sh "$URL" lin_wh_test "$BODY"`, where `$BODY` is `{"type":"Comment","action":"create","webhookTimestamp":<now in ms>,"actor":{"type":"user","email":"ada@acme.dev"},"data":{"id":"c1","body":"Why?","issue":{"id":"i1","identifier":"ENG-1","title":"T","url":"https://linear.app/acme/issue/ENG-1","team":{"key":"ENG"}}}}`. It gets 200 with one `started` run; the same body again gets a `skipped` run; another comment id on `i1` gets a `started` run with the same `threadId`. Another email or team gets 200 with `"runs":[]`, a wrong secret 401. For `linear.issue_assigned`, post `LINEAR_EVENT=Issue` with `"type":"Issue","action":"create"` and `data` holding the issue fields, `"assigneeId":"demo-viewer"` and an `updatedAt`.
- **CLI.** `pnpm build:server`, then `node bin/hinacode.mjs --data $DATA routines ls`.

## Gotchas

- Do not call the `reply` tool in a verification instance. It runs the real `gh` with your account. A `gh` stand-in on `PATH` does not help where the login shell puts its own `gh` first, because the app reads `PATH` from the login shell at startup. `mcp/server.integration.test.ts` covers the post.
- With `HINACODE_MOCK_CLAUDE`, post a follow-up event only after the thread is idle. The simulated agent refuses every steer, so an event that lands on its running turn is recorded as a failed run with `No turn is running on this thread`. `Routines.integration.test.ts` covers two events that arrive together.
- A hand-built `issue_comment` payload needs `issue.id`, `issue.number`, `issue.title`, `issue.html_url`, `issue.user.login`, `comment.id`, `comment.body`, `repository.full_name`, `sender.login` and `sender.type`. A payload that misses one gets 202 with `"runs":[]`, the same answer as an event nobody listens for.

- A Linear delivery needs a `webhookTimestamp` in milliseconds within a minute of now. Build the body right before posting, such as with `$(date +%s%3N)`; a stale or missing one gets 401, the same answer as a wrong signature.
- Launch with `HINACODE_MOCK_LINEAR=1` before you call `reply` on a Linear thread. Without it `reply` posts a real comment with the stored `linear.apiKey`. The mock knows the API key's account as `demo-viewer` and answers `reply` without reaching Linear.
- Linear answers 200 to every delivery it accepts, including one nobody listens for, because Linear retries anything else. Read `runs` to tell them apart.
- An assignment's prompt has an empty `text` and the issue description under `context`. Without `HINACODE_MOCK_LINEAR=1`, an assignment with no API key or with a key Linear refuses gets 200 with `"runs":[]`, and a lookup that fails for another reason gets 503.

- A wrong secret gets 401 before the routine id is looked up, so an unknown id with a wrong secret is 401, not 404.
- Effort shows only for models that report effort levels; the mock models report none.
- `routines.list` merges every connected machine. Every other routine method goes to the machine that owns the id.
