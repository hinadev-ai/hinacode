# Plan limits in the status bar

Status: Building
Date: 2026-10-12

## Problem

A developer on a Claude or ChatGPT subscription runs out of the 5-hour or weekly allowance in the middle of a thread. Today they find out when a turn is refused. They need to see how much of each window is left before starting long work, and on which account.

## User flow

1. The status bar's left side shows one group per signed-in account: the provider icon, a meter of its most-used window, and its windows as "79% used 0m · 66% used 2d 6h · 56% used Fable". The time is when the window resets.
2. A group is shown in full when it is its provider's only account, or the account the open thread uses. Any other account collapses to its icon, name, meter and top percentage, so several accounts fit.
3. Hovering or focusing a group shows the account (email and plan) and every window with its label and reset time.
4. A window at 80% or more turns amber. One at 100% turns red.
5. An account that has no plan limits, such as an API key, Bedrock or Vertex, shows no group.

## Design

- Shape in `src/shared/limits.ts`.
  - `LimitWindow { window, usedPercent, resetsAt }`. `window` is `{ kind: "session" }` (5 hours), `{ kind: "weekly" }`, `{ kind: "model", name }` (a per-model weekly bucket such as "Fable"), or `{ kind: "minutes", minutes }` for a duration Codex reports that is neither of the others.
  - `PlanLimits { windows, readAt }`.
- `AgentProvider.planLimits` returns `PlanLimits | null`.
  - Claude reads the SDK's experimental `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })` through the existing `probe`. It is decoded with a schema, and any failure becomes null, so an SDK change hides the group instead of breaking the bar. `five_hour` maps to session, `seven_day` to weekly, and each `model_scoped` entry to model. `model_scoped` carries the server's current bucket names (a Team account reports "Fable" there while `seven_day_opus` and `seven_day_sonnet` are null), so those two fixed fields are read only when `model_scoped` is absent.
  - Codex reads `account/rateLimits/read` from `rateLimitsByLimitId`, falling back to `rateLimits`. Windows are named by `windowDurationMins`: 300 is session, 10080 is weekly. A window without a duration is left out, since it can't be labeled.
- rpc `limits.list` returns one entry per account, `{ provider, accountId, limits }`. Until multiple accounts land, there is one entry per provider with `accountId: null`.
- Main caches each account's limits for 60 seconds, because a Claude read spawns a CLI. The renderer polls every 2 minutes and refreshes when any turn ends.

## Out of scope

- Extra usage, credits and spend controls.
- Warnings or notifications as a limit approaches. The amber meter is the signal for now.

## Verification

- Decoding tests feed real-shaped responses from both providers, including a missing `model_scoped`, a null `utilization` and an unknown Codex window.
- With `verify-kkcode`, compare the bar against Claude's `/usage` and Codex's `/status` for the same accounts. Check both themes.
