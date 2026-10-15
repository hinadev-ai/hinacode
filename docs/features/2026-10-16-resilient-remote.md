# Resilient remote control

Status: Building
Date: 2026-10-16

## Problem

The phone app and the desktop's link to a cloud assume a steady connection. On a phone that assumption fails every few minutes: Wi-Fi hands over to cellular, the app goes to the background, a train enters a tunnel. What the developer sees today:

- The badge says Connected while the socket is half-open. Send clears the draft and waits forever, Approve spins, keystrokes vanish. Nothing pings, and calls have no timeout.
- A prompt whose reply was lost comes back as an error with the draft restored. Sending it again steers the turn that the first one already started, so the agent gets the prompt twice.
- Any blip wipes the open chat to a spinner, and an answer half-typed into a question card is gone.
- Every reconnect kills the phone's shell. A `pnpm test` started from the phone dies on a network switch, and a shell closed while offline leaks until the thread is archived.
- A slow link that misses the 5 s auth deadline gets close code 4001, which both clients read as a revoked token, so they stop retrying and ask to pair again.
- After the network returns, the phone may sit out a 30 s backoff, and a pairing pins one address, so leaving home Wi-Fi on a LAN pairing never reconnects.

The developer should be able to trust a tap. An action is either delivered once or reported as not delivered, and the screen keeps showing the last known state while the link heals.

## User flow

1. On the phone, the developer opens a thread and walks out of Wi-Fi range. Within a few seconds the thread shows "Reconnecting. Actions send when the desktop is back." The transcript, cards and terminal stay on screen.
2. They tap Allow on an approval and type a prompt while offline. Both show as pending.
3. The phone joins cellular. It reconnects at once through the pairing's Tailscale address, sends the approval and the prompt once each, and refreshes the transcript. The shell they left running is the same shell, with the output it printed meanwhile.
4. If the link stays down for 60 s, each pending action fails with "Not sent. The desktop was unreachable for a minute." and the prompt goes back into the composer.
5. The desktop driving a cloud behaves the same way: a call made while the cloud drops for a few seconds completes after it reconnects, once.

## Design

The pieces are a heartbeat, retry with call keys, close codes that say what happened, a terminal that can be re-attached, and a pairing with every address. Each one is small, and none of them needs a server-side event log: after a reconnect, the client reloads its snapshots as it does now, so a gap in pushes is repaired without replaying them.

### Wire (`src/shared/remote.ts`), additive

```ts
ClientFrame =
  | { type: "auth"; token: string }
  | { type: "call"; id: number; method: string; payload?: unknown; key?: string }
  | { type: "ping"; at: number }

ServerFrame =
  | { type: "ready"; version: 1; environment?: {...}; features?: ReadonlyArray<RemoteFeature> }
  | { type: "result"; id: number; envelope: RpcEnvelope<unknown> }
  | { type: "event"; event: PushEvent }
  | { type: "pong"; at: number }

RemoteFeature = "heartbeat" | "call-keys" | "terminal-attach"
```

- `REMOTE_PROTOCOL_VERSION` stays 1. A client sends `ping` or `key` only when `ready.features` lists it, so a new phone still works against an old desktop, and an old phone ignores the new frames.
- `call.method` becomes a plain string. `dispatch` already answers an unknown method with an error envelope, so a version skew fails one call instead of closing the socket.

Close codes, in `src/main/remote/access.ts`:

| Code | Meaning                                            | Client action    |
| ---- | -------------------------------------------------- | ---------------- |
| 4001 | wrong token                                        | stop, pair again |
| 4002 | token rotated                                      | stop, pair again |
| 4003 | listener stopped                                   | retry            |
| 4004 | no `auth` within the deadline (new; was 4001)      | retry            |
| 4005 | malformed frame (new; was 4001)                    | retry            |
| 4006 | client too slow, `bufferedAmount` over 8 MiB (new) | retry            |

### Which calls are safe to repeat

`src/shared/contract.ts` gains `methodKind: Record<RpcMethod, "read" | "mutation">`. A `Record` over every method makes the compiler refuse a new method until someone decides which kind it is. `mutations` is the derived set.

- A read is retried by sending it again. It must run again, because its answer from before the outage can miss pushes lost during it (a stale `threads.transcript` snapshot would look current).
- A mutation carries a `key`, a random id the client creates once per user action and reuses on every retry of it. If an older server does not advertise `call-keys`, a mutation sent before a disconnect fails with an uncertain-delivery error instead of replaying. Reads and unsent mutations still queue. Replaying a mutation without server deduplication could run it twice.

### Server

- **Call keys.** `RemoteServer` keeps `keyed: Map<key, { result: Promise<RpcEnvelope>, settledAt: number | null }>`. A call whose key is in flight waits for the same promise. A settled key answers its stored envelope without running anything. Entries expire 5 minutes after settling, and the map holds at most 2,000 entries, evicting the oldest settled one. When every entry is still running, a new keyed call receives `RemoteBusy` without dispatching; retries of existing keys still join their original call. The cache lives in memory: after a restart a retried mutation runs again, which is acceptable because a restart also ended the original.
- **Heartbeat.** It answers `ping` with `pong`. Every 20 s it sends a WebSocket protocol ping to each authenticated socket and terminates one that has not answered the previous ping. React Native, browsers and `ws` answer protocol pings on their own. The schedule is an Effect `Schedule`, so tests drive it with `TestClock`.
- **Slow consumers.** `send` closes the socket with 4006 when `bufferedAmount` is over 8 MiB, instead of letting a dead phone buffer terminal output until TCP gives up.
- `maxPayload` rises from 1 MiB to 16 MiB, so a large `fs.write` routed to a cloud does not drop the link.

### Clients (phone `apps/mobile/src/lib/connection.ts`, desktop `src/main/services/Environments.ts`)

Both get the same policy:

- **Outbox.** A pending call is `{ id, method, payload, key?, offlineSince: number | null, resolve, reject }`. A dropped socket no longer rejects it. After the next `ready`, every pending call is sent again in order, with its key if it is a mutation. A call made while reconnecting is queued, not refused. A call fails with tag `Timeout` once its link has been down for 60 s in total, and the message says a mutation may still have run. Time while connected does not count, because the heartbeat already notices a dead link, and calls such as `projects.clone` can legitimately take minutes.
- **Heartbeat.** It sends `ping` every 10 s while connected and in the foreground. If no frame of any kind arrives for 25 s, it closes the socket and reconnects. The desktop keeps its protocol pings, with the same 25 s rule.
- **Connect timeout.** If `ready` has not arrived 10 s after the socket was created, it closes the socket and retries.
- **Backoff.** 0.5, 1, 2, 4, 8 s, capped at 10 s on the phone and 60 s on the desktop, with ±30% jitter. It retries on every close code except 4001 and 4002.
- **Phone triggers.** NetInfo (`@react-native-community/netinfo`) reports a network change, so the phone closes the current socket and reconnects at once, since after a Wi-Fi to cellular switch the old TCP connection is dead even if it looks open. When the app returns to the foreground, a connected phone pings and reconnects if nothing answers within 5 s, and an offline phone skips its backoff.

### Phone state across a reconnect

- `useMessages.reset()` runs only on disconnect or unpair, not while reconnecting. On each `ready`, loaded histories reload their snapshot and swap it in atomically, keeping the existing seq buffering. Cards stay mounted, and so does text typed into them.
- `useThreads.load()` merges by `updatedAt` instead of replacing, so a `thread.updated` push that arrived during the reload is not overwritten by an older list.
- The composer shows a sent prompt as pending until its result. It restores the draft only when the call finally fails.

### Terminals

- `Terminals` keeps the last 256 KiB of output per session, and `written`, the count of characters emitted so far. `terminal.data` gains `offset`, the position of its first character. The field is additive, so old clients ignore it.
- `terminal.attach { id, since: number | null } -> { session, offset, data }` returns output from `max(since, scrollback start)`. When `offset > since`, output was dropped, so the client clears the screen and writes `data`. Otherwise it appends. Pushes that overlap what attach returned are trimmed by offset.
- The phone's `TerminalPanel` is keyed by session id, not connection generation. On each `ready` it attaches with its last offset. It closes the session only when the user leaves the thread, and a close made while offline waits in the outbox like any other mutation. The desktop drawer attaches the same way for cloud terminals.

### Pairing with every address

`kkcode://connect?host=a&host=b&port=…&token=…` repeats `host`. `PairingTarget` becomes `{ hosts: NonEmptyReadonlyArray<string>, port, token }`, and the parser still accepts the single-host form. The phone tries the last host that worked first, then the others in order, moving on at each failed attempt. The QR code in Settings > Remote carries every reachable host, Tailscale first. Desktop environments keep one host in this change.

## Slices

Each slice is one PR with its own check:

1. **Server and desktop client.** Frames, `methodKind`, call keys, the heartbeat, close codes, slow consumers and the payload cap. `Environments` gets the outbox, keys and the close codes. Check: integration tests in `src/main/ipc.integration.test.ts` and `Environments.integration.test.ts` for a keyed mutation retried from a second socket running once, a dead socket terminated under `TestClock`, an unknown method answered without closing, auth timeout 4004, and a cloud call that survives a reconnect.
2. **Terminal attach.** Scrollback, offsets and `terminal.attach`, plus the drawer attaching cloud terminals. Check: integration tests that attach `since` an offset, after the buffer wrapped, and on an exited session.
3. **Phone.** The outbox, heartbeat, timeouts, backoff, NetInfo, foreground check, store behaviour, pending composer and terminal attach. Check: Vitest on the connection logic with a fake `WebSocket`, plus the real-surface runs below.
4. **Every address.** Multi-host pairing URLs and host rotation. Check: parser tests, and the phone falling back to a second host when the first is a blackhole.

## Out of scope

- A server-side event log or resuming from a `seq`. Snapshots after a reconnect already repair gaps, and a log would be a second source of truth.
- Push notifications to a closed phone app, a relay or tunnel, and TLS, all unchanged from remote mode.
- Chunking individual response frames. A very large snapshot on a slow link can still exceed the 8 MiB buffer or 25 s silence limits and repeatedly reconnect.
- Several hosts per desktop environment, and remembering clouds across a desktop restart.
- Desktop notifications for approvals requested during an outage.

## Verification

- Tests as listed per slice. Tests never wait on wall-clock time: the server's schedules run under `TestClock`, and the phone's connection logic runs under Vitest fake timers.
- `scripts/flaky-proxy.mjs`: a TCP proxy between a client and the remote listener, controlled over HTTP (`pass`, `blackhole` that keeps sockets open but forwards nothing, `reset` that destroys them, `delay <ms>`). It is the fault injector for the runs below and for future debugging.
- With the phone web export (`npx expo export --platform web`) in agent-browser at 390x844, paired through the proxy to an isolated kkcode:
  1. Blackhole for 30 s while idle. The banner appears within 25 s, the transcript stays, and after `pass` the phone is connected again within 2 s.
  2. Send a prompt, then `reset` before the result arrives. After the reconnect the transcript has exactly one copy of the prompt, and the composer is empty.
  3. Start `for i in $(seq 1 30); do echo $i; sleep 1; done` in the terminal, blackhole for 8 s, then pass. The output has every number once, and `echo $$` prints the same PID before and after.
  4. Tap Allow during a blackhole. After the reconnect the approval is applied once.
- The same with the desktop driving a `kkcode serve` cloud through the proxy: a send during a 5 s `reset` lands once.

### Fault injector

Run `node scripts/flaky-proxy.mjs <proxy-port> <listener-port> <control-port>` on the same machine as the listener. Pair the client with the proxy port. The proxy binds both listeners to `127.0.0.1`.

Send `POST /pass`, `/blackhole`, `/reset`, or `/delay?ms=250` to the control port. `reset` destroys existing connections and refuses new ones until the next mode. `blackhole` discards bytes in both directions while keeping TCP connections open. `GET /` reports the current mode and connection count.
