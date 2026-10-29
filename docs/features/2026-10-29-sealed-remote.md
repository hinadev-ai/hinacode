# Sealed remote frames

Status: Building
Date: 2026-10-29

## Problem

A developer drives a cloud from the desktop or approves a command from the phone. Through the relay, Cloudflare can read every frame. On a direct address at a café, anyone on the network can. Those frames hold the code, prompts, terminal output and approvals, and a reader can also inject a call that runs a command.

## User flow

Nothing changes. Pairing, the QR code, the relay sign-in and every screen stay the same. A device on the old protocol connected to an updated machine, or the reverse, shows the existing "update the older one" message instead of connecting.

## Design

`src/shared/handshake.ts` holds the whole protocol. [ADR 0024](../adr/0024-remote-frames-are-sealed-with-the-pairing-token.md) explains why.

```
server                                          client
challenge { nonce: server key }        ->
                                       <-       auth { nonce: client key, proof, sealed: true }
sealed ready { version: 2, proof, ... } ->
sealed frames                         <->       sealed frames
```

- `newKeyPair()` makes an X25519 key pair per socket. The public key in hex is the nonce, so `clientProof` and `serverProof` from ADR 0022 cover both keys.
- `openChannel(side, token, own, peerNonce)` derives 64 bytes with HKDF-SHA256, from the X25519 secret, salted with the token, with both keys in the info. The first half seals frames to the client and the second to the server. `seal` and `open` use ChaCha20-Poly1305 with a 12-byte nonce from a frame counter, which neither side sends, since a WebSocket keeps order. A frame that was replayed, dropped, reordered or tampered with fails to open, and the socket closes.
- `clientHandshake(token)` is the client's half, run by both `Environments.ts` and the phone's `transport.ts`. It answers the challenge, and only a sealed `ready` that proves the token counts as the machine. A plain `ready` is accepted only from a machine on an older version that proved the token, to show the version message. A plain `ready` claiming the current version means someone is stripping the encryption, so the client refuses it.
- `server.ts` reads `auth` in plain text and everything after it sealed. An `auth` without `sealed` and with a valid proof gets a plain `ready` with the version, then the socket closes with `CLOSE_OUTDATED_CLIENT`.
- Sealed frames are binary WebSocket messages. The phone asks for an `ArrayBuffer`, and `src/lib/random.ts` gives Hermes `crypto.getRandomValues` from `expo-crypto`.

## Out of scope

- Per-device keys. The token stays the one long-term secret a device holds.
- Compressing before sealing. Phones never negotiated compression, and compressing secrets next to text an attacker can choose leaks them.
- Keeping protocol 1 clients connected. HinaCode is in alpha, and a client that predates sealing would send readable frames.

## Verification

- `src/shared/handshake.test.ts`: frames open only with the same token and in order, replays and tampering fail, the client refuses a stranger, a skipped challenge and a stripped `ready`, and hears an older machine's version.
- `src/main/ipc.integration.test.ts`: the listener seals every frame after the challenge, so a known string never appears on the wire, closes plain frames after `auth`, and tells an older client its version.
- `src/main/services/Environments.integration.test.ts` and `apps/mobile/src/lib/transport.test.ts`: both clients connect sealed, never send the token, mark an older machine incompatible, and redial after a frame that does not open.
- By hand: a desktop pairs with `hinacode serve`, lists its projects and runs a thread. A capture of the loopback socket shows only the challenge and `auth` in plain text.
