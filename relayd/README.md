# hinacode-relayd

A relay you run yourself, so phones and other machines reach a HinaCode machine from any network without Cloudflare. It is one Go binary with no state. Sessions stay end-to-end encrypted to the machine's key (`docs/adr/0027-end-to-end-encryption-with-a-pinned-host-key.md`), so the relay only ever copies ciphertext. The design is in `docs/features/2026-11-26-self-hosted-relay.md`.

## Run it

Generate the token that machines attach with, and keep it secret:

```sh
openssl rand -base64 32
```

On a server with a public DNS name and port 443 open, let the relay get its own Let's Encrypt certificate:

```sh
HINACODE_RELAY_TOKEN=<token> hinacode-relayd -domain relay.example.com -listen :443
```

Or with Docker:

```sh
docker build -t hinacode-relayd relayd
docker run -d --restart unless-stopped -p 443:8443 -e HINACODE_RELAY_TOKEN=<token> \
  -v relayd-certs:/certs hinacode-relayd -domain relay.example.com -cert-cache /certs
```

To use a certificate you already have, pass `-tls-cert` and `-tls-key`. Prefer an ECDSA P-256 certificate: the handshake signature is most of the cost of a new connection, and ECDSA cut it by 68% against RSA 2048 in the benchmarks. Behind a proxy that terminates TLS, leave both out and the relay serves plain HTTP. The proxy must pass `Upgrade` requests through unbuffered and must not use HTTP/2 towards the relay.

Then, on each machine, open Settings > Connections, choose **Use your own relay**, and enter `https://relay.example.com` and the token. A `hinacode serve` cloud reads `HINACODE_SERVE_SELF_HOSTED_RELAY` and `HINACODE_SERVE_SELF_HOSTED_RELAY_TOKEN` instead.

| Flag                    | Default                 | Meaning                                                                                |
| ----------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `-listen`               | `:8443`                 | Address to listen on                                                                   |
| `-domain`               |                         | Get a certificate for this name over TLS-ALPN. The relay must be reachable on port 443 |
| `-cert-cache`           | `hinacode-relayd-certs` | Where `-domain` certificates are kept across restarts                                  |
| `-tls-cert`, `-tls-key` |                         | Serve this certificate instead                                                         |
| `-token-file`           |                         | Read the token from a file instead of `HINACODE_RELAY_TOKEN`                           |
| `-verbose`              | off                     | Log every attach and session                                                           |

## Protocol

There are two routes, both HTTP/1.1 upgrades on the same port.

- `GET /h/<id>/attach` with `Authorization: Bearer <token>` and `Upgrade: hinacode-relay/1`. A machine keeps two of these open and idle. Past eight for one machine, the relay closes the oldest, so a machine that reconnects after a network change is never refused. `<id>` is the machine's environment id, 16 to 64 characters from `[A-Za-z0-9_-]`. While a connection is idle the relay sends `0x00` every 15 seconds and the machine echoes it. A connection silent for 40 seconds is closed. To hand it a client, the relay sends `0x01`, then the client's upgrade request rewritten to `GET /remote`, then the raw client bytes. The machine answers `0x01`, then the bytes of its own listener's response, and opens a replacement idle connection.
- `GET /h/<id>/remote` with `Upgrade: websocket`, from a client. The relay takes the newest idle machine connection, waiting up to 5 seconds for one, and from then on copies bytes both ways without reading them. It never parses a WebSocket frame.

Answers: 401 for a wrong token, 404 for a machine that never attached, 426 for a request that is not the expected upgrade, 502 when no idle connection frees up in time, and 503 past 64 sessions for one machine.

## What the relay sees

Which machine id is reached, from which address, when, and how many bytes move each way. The token protects attaching: without it nobody can take over a machine's id. A client needs no token, because the Noise handshake to the machine's pinned key is what admits it, and a client the machine does not trust gets nothing past the handshake.

## Measure it

`go test -bench . -benchmem` runs the relay in process with TLS on both legs. `bench/run.sh` puts a phone, the relay and a machine running the real Node connector in three Docker containers, slows each one's network with `tc netem` (`PHONE_MS`, `RELAY_MS`, `MACHINE_MS`, `LOSS`, `RATE`), and prints connect time, round-trip time and 16 MiB echo throughput, both directly and through the relay. It needs Docker and Go.
