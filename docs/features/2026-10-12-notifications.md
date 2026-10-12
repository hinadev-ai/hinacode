# Notifications

Status: Implemented
Date: 2026-10-12

## Problem

A developer starts a few agents and goes back to other work. The sidebar shows which thread finished, failed or waits for an approval, but only if they look at it. A blocked approval can sit for an hour because nothing pulled them back.

## User flow

1. A thread's turn finishes, fails, hits a usage limit, or asks for an approval, an answer or a secret.
2. If the developer is not looking at that thread, kkcode shows a desktop notification titled with the thread name, and plays a short chime. The chime rises for a finished turn, repeats for a request, and falls for a failure, so the kind is clear without reading.
3. Clicking the notification brings kkcode forward and opens the thread.
4. In Settings, Notifications, the developer turns each kind on or off and turns the chime off.
5. On macOS, the same page says when macOS blocks kkcode's notifications, or has not asked yet. "Allow notifications" makes macOS ask now instead of at the first alert. A development build also has a "Send test notification" button.

"Looking at the thread" means the window has focus and the thread is open. Stopping a turn from its own composer therefore never notifies.

## Design

The renderer already receives every turn event as a `thread.event` push, knows the open route, and knows whether the window has focus. The notifier lives there, with no new service or table. Clicking a notification calls the validated `app.focus` rpc to restore, show and focus only the window belonging to the sending app frame. The renderer then opens the thread.

- `Settings.notifications` holds one boolean per `ThreadAlert` (`completed`, `needsInput`, `failed`) plus `sound`. It is a settings row like any other, so defaults fill in for existing profiles and no migration is needed.
- `lib/threadNotifications.ts` maps an `AgentEvent` to an alert and a body in one table: `turn_completed` is `completed`, `approval_requested`, `question_requested` and `secret_requested` are `needsInput`, `turn_failed` and `turn_limited` are `failed`. Other events map to nothing.
- `main.tsx` hands each `thread.event` to the notifier, which checks the setting and whether the thread is on screen, then creates an HTML `Notification` with `silent: true` and plays the chime itself. The `tag` is the thread id, so a newer alert replaces an older one from the same thread.
- The chime is synthesized with Web Audio. No audio asset ships, and the CSP needs no `media-src`.
- macOS permission is read in main with `node-mac-permissions`, because Electron exposes no API for it and the renderer's `Notification.permission` always says `granted`. The npm release lacks `notifications`, so the dependency is pinned to the upstream commit that adds it, and the `allowBuilds` key names the git repository. It is optional and darwin-only, and main reports `unknown` without it.
- "Allow notifications" shows one notification from main. Main's `failed` event is the only reliable sign of a refusal: a refused renderer notification fires no event. macOS can refuse without ever asking and still report "not determined", as it does for the stock `Electron.app` that `pnpm dev` runs. So development builds on macOS show no banners, only the chime.

## Out of scope

- Notifications while every window is closed on macOS. The renderer is gone then. Moving the notifier to main would need main to learn the open route, for a rare case.
- Choosing or uploading a sound, and a volume slider. One quiet chime per kind is enough until someone asks.
- Dock badges and per-project rules.

## Verification

`e2e/features/notifications.feature` pushes turn events for a thread that is not open and asserts on a stubbed `Notification`: the title, the body, that a disabled kind stays quiet, and that clicking opens the thread. Banners themselves need a signed kkcode build on macOS. Check them there, including the first-run prompt from "Allow notifications".
