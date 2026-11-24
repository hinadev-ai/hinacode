# 0027. Remote sessions are end-to-end encrypted to a pinned host key

Status: Accepted
Date: 2026-11-25

## Context

[ADR 0020](0020-cloudflare-tunnel-as-the-relay.md) accepted that Cloudflare terminates TLS and can read relayed frames. [ADR 0022](0022-clients-prove-the-pairing-token.md) left direct connections unencrypted on the LAN. [ADR 0021](0021-the-relay-holds-each-machines-pairing.md) put every shown machine's pairing token in D1, so the relay operator, a D1 read or one stolen device credential could open every machine. A remote session can start agents and run commands, so each of those parties held a shell on the developer's machines. All three ADRs named end-to-end encryption with a pinned host key as the next step, and developers now expect it by default rather than behind Tailscale.

## Decision

Every remote session runs `Noise_IK_25519_ChaChaPoly_SHA256` from the client to the machine, on the relay and on direct addresses alike, and every frame after the handshake is encrypted. Trust roots in two keys: the machine's public key, pinned from the QR code or confirmed with an approval code, and each client's own key, which the machine trusts after a one-time pairing secret from the QR code or after the developer types the device's approval code on the machine. The approval code commits to a nonce from each side before either is revealed, so neither end can search for a match. The relay stores addresses and public keys, never a secret. There is no plaintext fallback: a new client never sends a plaintext frame, and a machine answers old clients only with an update message.

## Consequences

- Cloudflare, the relay operator and the LAN see ciphertext, plus which machine is reached, when, and how large each frame is. The feature doc lists what still leaks.
- Supersedes ADR 0021's plaintext token in D1, and the "Cloudflare can read frames" and "a direct connection is still unencrypted" consequences of ADR 0020 and ADR 0022. The relay service stays dumb: it never decrypts a frame and holds no secret that grants access.
- A device learned through the relay needs one approval per machine: the developer types its code on the machine and confirms on the device. That is the price of not trusting the relay with access.
- The server acts on the first encrypted frame, never on handshake message 1, which anyone who recorded it can replay.
- Every existing pairing must be redone once, because none of them carries a key and the old tokens sat in D1. Old apps get the version-mismatch message they already know.
- Each machine keeps a list of trusted devices that the developer can review and prune. Removing one ends its sessions. Only the desktop window and the CLI can approve or remove devices, never a remote session.
- Two operator paths stay open and are listed in the feature doc: the web app's JavaScript, which HinaCode's Cloudflare account serves, and outside apps approved on the relay page.
- We maintain our own Noise IK implementation on `@noble/*`, held to the published test vectors, because the maintained JavaScript Noise libraries depend on libsodium or libp2p and do not run in Hermes. Frames above Noise's 64 KiB message limit are encrypted whole with the same cipher states.
- Frames no longer compress on the wire. Revisit with compression before encryption if a measured slow link needs it.
- Revisit if a client cannot hold a key, or if hiding which machine a client reaches becomes a requirement.
