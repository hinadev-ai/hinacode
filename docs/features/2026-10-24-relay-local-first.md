# Prefer the local network over the relay

Status: Building
Date: 2026-10-24

## Problem

Clients dial the relay first and then stick to whichever address worked last. At home, every frame between the phone and the home server goes out to Cloudflare and back: about 20 ms more per round trip, Cloudflare reads it, and nothing connects when the internet is down. A phone that connected through the relay while away keeps using it after it comes home.

## User flow

Nothing to do. At home the phone, the iPad and every desktop connect to a machine's direct address. Away, the relay answers instead, half a second later than a direct address would. Back home, the client moves to the direct address within a minute, or at once when the phone notices the network change.

## Design

`dialPlan(target)` in `src/shared/remote.ts` replaces `remoteSocketUrls`. It lists every direct address at delay 0 and the relay at `RELAY_DELAY_MS` (500 ms).

- **Race.** Each connection round opens a socket per dial after its delay. The first socket to open wins, and every other socket closes without receiving a frame, so the pairing token goes to the winner only. No socket open within the connect timeout is a lost link with the usual backoff. This replaces the sticky last-worked index on both clients.
- **Move back.** While connected over the relay, a client opens the direct dials every `DIRECT_CHECK_INTERVAL_MS` (one minute) without authenticating, waits up to `DIRECT_CHECK_TIMEOUT_MS`, and when one opens it ends the relay session and races again at once. The phone checks only in the foreground and once on returning to it, and it already races again on every network change.
- The desktop does this in `Environments.maintain`, the phone in `Transport`.

### Trust

A direct address can belong to someone else on another network: `192.168.1.20` at a café is not your home server. Dialing local first makes it likelier that such an address answers before the relay, and the winner receives the pairing token. Racing on `open` keeps the token to one socket, as the sequential walk did. Closing the gap needs the server to prove itself before the client sends the token, for example a challenge the client answers with an HMAC of the token instead of the token. That is a protocol change for both sides and is the next step, not part of this one.

## Out of scope

- Showing which route a connection uses.
- Challenge-response authentication, above.

## Verification

- `src/shared/remote.test.ts`: the plan lists direct addresses at once and the relay after the delay.
- `src/main/services/Environments.integration.test.ts` and `apps/mobile/src/lib/transport.test.ts`: the direct address wins when both answer, the relay wins when the direct address does not, the loser never receives `auth`, and a relay connection moves to the direct address once it answers.
- By hand: a desktop instance and a `hinacode serve` instance linked to a local relay with real tunnels. The desktop connects direct. With the direct address unreachable it connects through the relay, and once the address answers again it moves back.
