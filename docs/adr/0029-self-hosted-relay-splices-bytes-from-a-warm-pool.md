# 0029. A self-hosted relay splices bytes from a warm pool of machine connections

Status: Accepted
Date: 2026-11-26

## Context

[ADR 0020](0020-cloudflare-tunnel-as-the-relay.md) made the relay a Cloudflare tunnel per machine and said a developer who did not want HinaCode's service could run the same Worker in their own Cloudflare account. That still needs Cloudflare. Since [ADR 0027](0027-end-to-end-encryption-with-a-pinned-host-key.md) the relay sees only ciphertext, so a relay anyone can run is safe to offer. It has to add as little latency as possible to a phone that already waits half a second before dialing it.

## Decision

HinaCode ships `hinacode-relayd`, an optional Go server. A machine keeps two idle, token-authenticated connections parked on it. A client's WebSocket upgrade to `/h/<machine id>/remote` takes one, and from then on the relay copies bytes both ways without parsing them. The machine pipes each connection into its remote listener's loopback port, as `cloudflared` does. The machine's advertised relay becomes `host[:port]/h/<id>`, so clients keep dialing `wss://<relay>/remote` unchanged. A setting chooses this relay over HinaCode's, and HinaCode's relay stays the default.

## Consequences

- No Cloudflare account, domain on Cloudflare, Clerk sign-in or `cloudflared` is needed. One binary and a token are enough.
- A connect costs the client's own TCP and TLS round trips and one pass through the machine leg. It does not wait for the machine to dial, which a control socket that summons a data socket would add (three machine-leg round trips in the bench profile).
- The relay never sees a WebSocket frame, so frame limits and compression stay with the machine, and a new remote protocol version needs no relay change.
- A token per relay, not per machine, means everyone with the token can attach under any id. That fits one developer's machines. A team would need per-machine tokens.
- Old apps refuse the new relay address shape and keep their direct addresses, so the change needs no protocol version bump.
- The app MCP server and the web app stay on HinaCode's relay. Revisit if a self-hosting developer needs either.
- Go joins TypeScript as a language we maintain, for this one binary. CI builds it for the integration test.
