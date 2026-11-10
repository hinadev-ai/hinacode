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
- **CLI.** `pnpm build:server`, then `node bin/hinacode.mjs --data $DATA routines ls`.

## Gotchas

- A wrong secret gets 401 before the routine id is looked up, so an unknown id with a wrong secret is 401, not 404.
- Effort shows only for models that report effort levels; the mock models report none.
- `routines.list` merges every connected machine. Every other routine method goes to the machine that owns the id.
