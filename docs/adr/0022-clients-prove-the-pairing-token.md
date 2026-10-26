# 0022. Clients prove the pairing token instead of sending it

Status: Accepted
Date: 2026-10-25

## Context

A client's first frame carried the pairing token. Clients now dial a machine's LAN address before its relay, so away from home someone else's HinaCode at the same address and default port can win the race and receive the token. With a relay, that token opens the machine from anywhere. `specs/RelayRouting.tla` found the path (`TokenStaysWithMachine`).

## Decision

The server sends a nonce first. The client answers with an HMAC-SHA256 of both nonces keyed by the token, and the server's `ready` answers with its own. Neither side sends the token, and the client counts a link as up only after checking the server's proof. A client that gets no challenge sends the token itself only over the relay, or to a pairing without a relay, whose server may predate the challenge. The server still accepts the token from clients that predate the challenge.

## Consequences

- A stranger at the machine's address gets a proof bound to nonces it cannot reuse, and the client moves on to the relay.
- No protocol version bump: older clients ignore `challenge`, and older servers never send it.
- Proofs use `@noble/hashes`, so the server, the desktop and the phone share one implementation; the phone has no HMAC in Hermes.
- A direct connection is still unencrypted, so someone on the same network sees its frames. End-to-end encryption with a pinned host key remains the next step.
- A pairing without a relay still sends the token to whatever answers its addresses when the server sends no challenge. Pair again after the cloud updates to close that.
