# Push notifications: hear from a thread when the phone is asleep

Status: Building
Date: 2026-10-28

## Problem

The phone raises a notification only while its JavaScript runs and its socket to the machine is open (`apps/mobile/src/components/notifier.tsx`). iOS suspends a backgrounded app within seconds and Android soon after, so "thread finished" or "waiting for your approval" reaches the developer only when they happen to open the app. The point of the phone is to step away from the desk and still unblock the agent.

## User flow

1. The phone is signed in to the relay (Settings > Relay, or the connect screen), as in `2026-10-24-relay-machines.md`, and the system allowed notifications. The phone registers itself for push right away, with no extra switch.
2. A thread on any machine linked to that relay finishes, fails, hits the usage limit, or asks for an approval, an answer or a secret. The machine asks the relay to push, and the relay pushes to every registered phone that keeps that kind of notice on in Settings > Notifications.
3. The phone shows "home-mac" over "A thread is waiting for your approval", whether the app is in the background or killed. Tapping it opens the app on that thread.
4. While the app is open and connected to that machine, the push stays quiet and the in-app banner shows instead, as today.
5. Turning a kind off in Settings > Notifications stops its pushes. Signing out of the relay, or rotating the owner token, stops all of them.

## Design

### One Worker, the relay

The relay already holds the two facts push needs: which owner a machine belongs to (the `host` row and its bearer credential) and how a phone proves it is the owner's (the owner token it signs in with). A second Worker would need its own copy of both, or a call into the relay on every push. So push is three routes and one table on the relay. Nothing in it waits on a tunnel, so a machine whose `cloudflared` is down still pushes.

### Expo push service, not APNs and FCM directly

The app already uses `expo-notifications`. Through Expo the relay makes one HTTPS POST with one token format and one error vocabulary for both platforms. Going direct means signing an APNs ES256 JWT from a `.p8` key, minting an FCM OAuth token from a service account, two payload formats and two sets of error codes, and two more Worker secrets. Expo's cost is that a third party sees the payload, which the payload rules below keep to nothing worth reading, and that the app needs an EAS project id and FCM credentials uploaded to EAS before Android tokens exist. Both are one-time setup, listed in `apps/mobile/README.md`.

### Data shape

Relay D1 (`relay/migrations/0004_devices.sql`):

```sql
CREATE TABLE device (
  token TEXT PRIMARY KEY,     -- ExponentPushToken[...]
  user_id TEXT NOT NULL,      -- the owner the phone signed in as
  alerts TEXT NOT NULL,       -- JSON array of "completed" | "needsInput" | "failed", the kinds the phone keeps on
  seen_at INTEGER NOT NULL    -- the last registration, in ms
);
```

The wire shapes, each decoded with a schema at the relay:

```ts
// PUT /v1/devices, owner bearer. Registers or refreshes; the same token moves its row, never duplicates it.
DeviceRegistration = { token: `ExponentPushToken[${string}]`; alerts: ReadonlyArray<"completed" | "needsInput" | "failed"> }
// DELETE /v1/devices, owner bearer.
DeviceRemoval = { token: string }
// POST /v1/host/push, machine bearer.
ThreadPush = { threadId: string; reason: "completed" | "approval" | "question" | "secret" | "failed" | "limited" }
```

`reason` is a closed set, so a machine cannot put arbitrary text on the owner's lock screen. The relay maps it to the alert kind it filters on and to the body it shows:

| reason      | kind         | body                                  |
| ----------- | ------------ | ------------------------------------- |
| `completed` | `completed`  | A thread finished                     |
| `approval`  | `needsInput` | A thread is waiting for your approval |
| `question`  | `needsInput` | A thread is waiting for your answer   |
| `secret`    | `needsInput` | A thread is waiting for a secret      |
| `failed`    | `failed`     | A thread failed                       |
| `limited`   | `failed`     | A thread stopped at the usage limit   |

### What a push carries

```json
{
  "to": "ExponentPushToken[...]",
  "title": "home-mac",
  "body": "A thread finished",
  "data": { "threadId": "...", "environmentId": "..." },
  "sound": "default",
  "priority": "high",
  "channelId": "threads"
}
```

The title is the machine's name from its `host` row. The thread's title, its messages, error text, paths and any token never leave the machine, because Expo, Apple and Google all see the payload, and a thread title is a summary of the developer's prompt. The ids are opaque and only mean something to a phone already paired with that machine. The body is English, like the rest of the phone's copy.

### Registering a device

`apps/mobile/src/lib/push.ts` reads the Expo token with the EAS project id from `app.json` and sends `PUT /v1/devices` with the owner token and the kinds turned on in Settings > Notifications. It does that after signing in, at every relay sync (launch, foreground, Sync now), and when a notification preference changes. Every registration bumps `seen_at`. Signing out sends `DELETE /v1/devices` before the account is forgotten. A phone without notification permission, without an EAS project id, or on the web registers nothing.

The device is bound to the owner, not to a machine, so one registration covers every machine linked to the relay, including ones the phone never paired with. A phone paired only by QR code, without a relay account, gets no pushes; the relay has nothing to bind it to.

### Who pushes

The machine's main process, desktop or `hinacode serve`, since they share the layer graph in `src/main/app.ts`. `src/main/remote/phonePush.ts` subscribes to `PushBroadcast`, maps each `thread.event` to a reason with the same table the desktop and the phone use for their own notifications, skips a completed turn with messages queued behind it, and calls `POST /v1/host/push` with the machine credential `relay.credential`. A machine that is not linked has no credential and pushes nothing. A failed push is logged and dropped; a notification minutes late is worse than none, so nothing retries. The relay sends one Expo request per push, with every matching device in it, and answers 204.

Hidden machines (Show on my devices off) still push. Hiding keeps a machine's pairing off other devices; a phone that paired with it by QR code still wants its notices.

### No duplicates on the phone

Two paths can now notify about the same event. The phone keeps exactly one:

- **Open and connected to the machine.** The socket's banner wins. The notification handler drops a push whose `environmentId` belongs to a connected server.
- **In the background with the socket still open.** The push wins. The notifier skips its local notification when this phone registered for push and the event came from a server that has a relay hostname, since that machine pushes.
- **Suspended or killed.** Only the push exists.

### Pruning

- Expo answers each message with a ticket. `DeviceNotRegistered` (the app was uninstalled or the token expired) deletes that row in the same request.
- Each push first deletes the owner's devices not registered for 90 days. An installed app that is opened at all re-registers at its first sync, so only abandoned installs age out. This also catches iOS uninstalls, which Expo reports only in delayed receipts.
- Rotating the owner token deletes every device, the same way it signs every device out of the machine list. Signing in again registers again.

Reading delayed receipts would need stored ticket ids and a cron; the age sweep makes it unnecessary for now.

## Out of scope

- Thread titles or message text in the push. Revisit with end-to-end encryption, where the phone decrypts in a notification service extension.
- Not pushing while the developer sits at the desktop. The daemon has no idea of presence; the phone's per-kind switches are the control for now.
- Reading Expo receipts, and Expo's enhanced push security access token.
- Pushes for a phone paired by QR code without a relay account.
- Localized push copy. The phone's copy is English only.

## Verification

- `relay/test/app.test.ts`: registration needs the owner token and refreshes rather than duplicates; a push needs the machine credential, reaches only devices that keep its kind, carries the machine name, the body and the ids and nothing else; `DeviceNotRegistered` deletes the row; a 90-day-old device is swept; rotating the owner token deletes every device.
- `src/main/remote/phonePush.integration.test.ts`: a linked machine pushes on each alert event with its credential, skips a completed turn with a queue, and pushes nothing when unlinked.
- `apps/mobile/src/lib/push.test.ts`: the dedupe rules above.
- By hand: `wrangler dev` with local D1, a machine linked through the real link and claim routes, a device registered with a well-formed but unknown Expo token, and a push sent to the real Expo service, which answers `DeviceNotRegistered` and the row disappears. A real token on the Android emulator needs the EAS project and FCM credentials from the one-time setup.
