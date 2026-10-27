# Plan limits

Status: Building
Date: 2026-10-12

## Problem

A developer on a Claude or ChatGPT subscription runs out of the 5-hour or weekly allowance in the middle of a thread. Today they find out when a turn is refused. They need to see how much of each window is left before starting long work, and on which account.

## User flow

1. The account picker in the composer shows how much of each account's plan is used, or when a spent window resets. See `2026-10-19-switch-accounts.md`.
2. An account that has no plan limits, such as an API key, Bedrock or Vertex, or one that is signed out, shows no hint.

The limits used to sit in a status bar along the bottom of the window, one group per account. On 2026-10-28 they were removed as too noisy for a number that matters only near a limit, and the status bar went with them.

## Design

- Shape in `src/shared/limits.ts`.
  - `LimitWindow { window, usedPercent, resetsAt }`. `window` is `{ kind: "session" }` (5 hours), `{ kind: "weekly" }`, `{ kind: "model", name }` (a per-model weekly bucket such as "Fable"), or `{ kind: "minutes", minutes }` for a duration Codex reports that is neither of the others.
  - `PlanLimits { windows, readAt }`.
- `AgentProvider.planLimits(home)` returns `PlanLimits | null` for the login in that agent home.
  - Claude reads the SDK's experimental `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })` through the existing `probe`. It is decoded with a schema, and any failure becomes null, so an SDK change hides the hints instead of breaking the picker. `five_hour` maps to session, `seven_day` to weekly, and each `model_scoped` entry to model. `model_scoped` carries the server's current bucket names (a Team account reports "Fable" there while `seven_day_opus` and `seven_day_sonnet` are null), so those two fixed fields are read only when `model_scoped` is absent.
  - Codex reads `account/rateLimits/read` from `rateLimitsByLimitId`, falling back to `rateLimits`. Windows are named by `windowDurationMins`: 300 is session, 10080 is weekly. A window without a duration is left out, since it can't be labeled.
- rpc `limits.list` returns one entry per account, `{ provider, accountId, limits }`: for each provider its CLI login (`accountId: null`), then its added accounts. A failed read or a signed-out account gives `limits: null`.
- Main caches each account's limits for 60 seconds, keyed by provider and account, because a Claude read spawns a CLI and a Codex read needs that home's app-server. The renderer polls every 2 minutes and refreshes when any turn ends.

## Out of scope

- Extra usage, credits and spend controls.
- Warnings or notifications as a limit approaches.

## Verification

- Decoding tests feed real-shaped responses from both providers, including a missing `model_scoped`, a null `utilization` and an unknown Codex window.
- With `verify-hinacode`, compare the account picker's hints against Claude's `/usage` and Codex's `/status` for the same accounts.
