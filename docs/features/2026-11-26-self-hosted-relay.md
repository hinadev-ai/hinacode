# Self-hosted relay

Status: Building
Date: 2026-11-26

## Problem

Reaching a machine from outside its network takes HinaCode's relay, which is a Cloudflare tunnel created in HinaCode's account behind a Clerk sign-in ([ADR 0020](../adr/0020-cloudflare-tunnel-as-the-relay.md)). Some developers cannot or will not route their sessions through a third party's account, even as ciphertext, and some run machines where `cloudflared` is not allowed. Their only option today is a VPN such as Tailscale on every device. Since [ADR 0027](../adr/0027-end-to-end-encryption-with-a-pinned-host-key.md) every session is encrypted to the machine's key, so the relay no longer has to be trusted, and anyone could run one.

## User flow

1. On a server with a public name, the developer runs `hinacode-relayd -domain relay.example.com` with a token from `openssl rand -base64 32`. The relay gets its own certificate (`relayd/README.md`).
2. On each machine, Settings > Connections > Remote > **Use your own relay**. They enter `https://relay.example.com` and the token, then press Connect. A `hinacode serve` cloud takes `HINACODE_SERVE_SELF_HOSTED_RELAY` and `HINACODE_SERVE_SELF_HOSTED_RELAY_TOKEN`.
3. The status line reads `Reachable at relay.example.com/h/<machine id>`, or `Connecting to …` with the reason, such as a refused token. The pairing QR code now carries that address as `relay`.
4. A phone that scans the code, or one already paired that sees the new address in `ready`, dials `wss://relay.example.com/h/<id>/remote` half a second after the direct addresses, as it does with Cloudflare today. The phone needs no token and no new app version.
5. **Stop using** clears the setting and the token. A machine linked to HinaCode's relay goes back to it.

## Design

### The relay

`relayd/` is a Go server with no state and one dependency (`x/crypto` for ACME). A machine attaches with `GET /h/<id>/attach`, a bearer token and `Upgrade: hinacode-relay/1`, and keeps **two idle connections** parked on the relay. A client's `GET /h/<id>/remote` WebSocket upgrade takes one. The relay writes `0x01`, the client's request rewritten to `/remote`, and any bytes it already read, all in one write, then splices the two TCP connections. It never parses a WebSocket frame. While parked, the relay pings with `0x00` and the machine echoes it. The `0x01` the machine sends back marks where its response starts, so a pong still in flight can never reach the client. The protocol and limits are in `relayd/README.md`.

This follows [Paseo](https://github.com/getpaseo/paseo-relay), whose relay also gives each client its own machine connection and never decrypts, with three changes:

- **A warm pool instead of a control socket.** Paseo tells the daemon over a control socket to dial a data socket after a client arrives, which adds the machine leg's TCP, TLS and upgrade round trips to every connect. Here the connection already exists, so a connect costs the client's own round trips plus one pass through the machine leg.
- **Machines need a token.** Paseo lets anyone who knows a server id connect as that server, which kicks the real one off. Here only token holders attach, and the comparison is constant time over SHA-256 digests.
- **Bytes, not frames.** Paseo forwards WebSocket messages. Here the relay copies bytes after the upgrade, so frame size limits and compression stay the machine's business, and the copy loop has nothing to allocate.

### The machine

`src/main/remote/selfHostedRelay.ts` keeps the pool. It is plain Node (`node:https`, `node:net`) so the bench can run it outside Electron. Each handed-over connection is piped to the remote listener's loopback port, the way `cloudflared` reaches it, so `server.ts` sees an ordinary local WebSocket. The `Relay` service (`relay.ts`) runs it in place of `cloudflared` while the `selfHostedRelay` setting is set, and publishes the same `RelayStatus`, so the status line, `ready.relay`, the pairing URL and `dialPlan` all work unchanged. The address is `host[:port]/h/<environment id>`. `parsePairingUrl` now accepts a port and that one path shape, and still refuses any other path.

| State                                            | Where                                                 |
| ------------------------------------------------ | ----------------------------------------------------- |
| `selfHostedRelay: "https://host[:port]" \| null` | Settings (`SelfHostedRelayUrl` in `shared/domain.ts`) |
| `relay.selfHosted.token`                         | `Secrets`, sealed like every secret                   |
| machine id                                       | the existing `environment.id` row                     |

`relay.useSelfHosted` and `relay.stopSelfHosted` are desktop-only rpc methods. While a self-hosted relay is in use, the app MCP server has no URL, because relayd forwards only `/remote` upgrades (`appsRelayHostname` in `access.ts`).

### What was measured

`relayd/bench/run.sh` runs a phone, the relay and a machine running the real connector in three containers. Each container's `tc netem` delay is added to every packet it sends: phone 30 ms, relay 5 ms, machine 15 ms. So phone to relay is 35 ms, relay to machine 20 ms, and phone to machine 45 ms. Medians of three runs:

|                       | Connect, TLS and first echo | Echo RTT p50 | 16 MiB echo | 4 parallel sessions |
| --------------------- | --------------------------- | ------------ | ----------- | ------------------- |
| Direct `ws://`        | 136.3 ms                    | 45.2 ms      | 60.0 MB/s   | 134 MB/s            |
| Through relayd        | 183.8 ms                    | 55.4 ms      | 79.7 MB/s   | 157 MB/s            |
| Floor from the delays | 180 ms                      | 55 ms        |             |                     |

The relay path sits within 4 ms of its floor on connect and 0.4 ms on RTT. It moves large frames faster than the direct path, because each leg is its own TCP connection with a shorter round trip, so congestion windows open sooner. Each hill-climb step, including the rejected ones, is logged in the PR.

## Out of scope

- **One relay for several people.** The token is per relay, so every machine that holds it may attach under any id. A per-machine token file is the next step if a team shares one.
- **The app MCP server and the web app over a self-hosted relay.** relayd forwards `/remote` only. The web app lists machines from HinaCode's relay service, which does not know about this relay.
- **Hiding which machine a client reaches.** The id is in the path, as the hostname is with Cloudflare.
- **Multi-region relays.** Run one near you. A relay is cheap enough that a second one in another region is a second process, not a cluster.

## Verification

- `relayd`: `go test -race ./...` covers a client reaching a machine with 4 MiB intact, token refusal, skipping a closed idle connection, and dropping a silent machine. `go test -bench .` measures connect, a 64-byte echo, streaming and heap per session.
- `src/main/remote/selfHostedRelay.integration.test.ts` builds relayd, serves it with a self-signed ECDSA certificate, attaches a real machine layer, and completes a Noise session from a phone client through it. It also checks the refused-token status and that stopping turns the relay off.
- In the real app, through `verify-hinacode`, a machine on loopback attached to a local relayd, showed the refused-token error, then `Reachable at …`. A phone-style client then enrolled through the relay, and `threads.list` answered.
