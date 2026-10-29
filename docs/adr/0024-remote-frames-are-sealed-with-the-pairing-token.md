# 0024. Remote frames are sealed with keys mixed from the pairing token

Status: Accepted
Date: 2026-10-29

## Context

Every remote frame was readable in transit. Through the relay, Cloudflare terminates TLS ([ADR 0020](0020-cloudflare-tunnel-as-the-relay.md)). On a direct address the socket is plain `ws://`, so anyone on the same café or office network sees it. Frames carry transcripts, prompts, diffs, terminal output and approvals, and someone who can read them can also inject calls.

The usual fix pins the host's long-term public key in the pairing URL. The pairing token already does that job: it is a secret only the machine and its paired devices hold, it travels out of band in the QR code or through the relay service, and since ADR 0022 it never crosses the wire.

## Decision

Each side makes a fresh X25519 key pair per socket and sends its public key as the handshake nonce, so the existing proofs cover both keys. The keys for each direction are HKDF-SHA256 of the X25519 secret, salted with the token. Every frame from `ready` on is a binary ChaCha20-Poly1305 message whose nonce is a per-direction frame counter. Clients never send the token, and refuse a socket that does not prove it, sends no challenge, or answers in plain text on this protocol. The protocol version becomes 2.

## Consequences

- Cloudflare, and anyone on the network of a direct address, sees only ciphertext and cannot answer for the machine or inject a call without the token.
- Fresh key pairs give forward secrecy. A token that leaks later, such as from the relay's D1 ([ADR 0021](0021-the-relay-holds-each-machines-pairing.md)), does not open sockets recorded before. Whoever holds the token now can still impersonate the machine, as before.
- The pairing URL does not change, so no device pairs again.
- One implementation in `src/shared/handshake.ts` runs on the server, the desktop and the phone, on `@noble/curves` and `@noble/ciphers`. Sealing 8 MiB takes about 50 ms in Node. The phone gets its random bytes from `expo-crypto`, since Hermes has no WebCrypto.
- Ciphertext does not compress, so the listener drops `permessage-deflate`. Phones never negotiated it, so only desktop-to-cloud sockets get larger.
- Mixed versions do not connect. A client on protocol 1 gets a plain `ready` with version 2 and asks to be updated. A protocol 2 client hears version 1 from an older machine and does the same. A server that predates the challenge is refused.
- An attacker on the path can still stop a link, though it cannot read or inject a frame. A protocol 1 `ready` is plain text, so it can forge one that makes the client report an outdated machine, as it can already forge close code 4001. `specs/SealedHandshake.tla` checks the rest and pins this case.
- Revisit if the token needs to stop being the only long-term secret, such as when a second person uses the relay: then each device gets its own key, and machines mint credentials for it.
