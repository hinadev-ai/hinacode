# 0021. The relay holds each machine's pairing and hands it to the owner's devices

Status: Accepted
Date: 2026-10-24

## Context

A developer's devices should see every machine linked to the relay without scanning a QR code per machine. A device needs a machine's pairing token to connect. T3 Code solves this without the relay ever holding a token: the relay asks the machine, through its tunnel, to mint a one-time credential bound to the device's key, and the device redeems it with the machine. That takes signed requests in both directions, replay guards, a channel from the relay to each machine, and a new handshake on every client.

The relay has one owner today. Whoever holds the owner token, or the relay's Cloudflare account, can already reach every linked machine: the account can re-route any tunnel, and Cloudflare terminates TLS.

## Decision

Each linked machine publishes its pairing (direct addresses, port and token) to the relay, which stores it in D1 and returns it, for the machines the owner chose to show, to any request carrying the owner token. Devices add those pairings the way they add a scanned one.

## Consequences

- Signing a device in once replaces a QR scan per machine, and a rotated token reaches every signed-in device at its next sync.
- No new protocol on the remote listener, and no channel from the relay to the machines.
- D1 holds every shown machine's pairing token in plaintext. Reading D1 or stealing the owner token is enough to reach those machines. Both already required access that could do the same through the tunnel, so the owner loses little, but a D1 export is now as sensitive as the owner token.
- Every signed-in device holds the owner token, which can also rotate itself and change what the relay shows. Losing a device means rotating it.
- Revisit before a second person uses the relay: per-device sign-in through Clerk, and credentials minted by each machine as T3 Code does, so the relay stops holding tokens.
