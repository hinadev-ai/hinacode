# 0020. The relay is a Cloudflare tunnel per machine, handed out by a HinaCode service

Status: Accepted
Date: 2026-10-24

## Context

ADR 0016 made the middle of the remote design a dumb relay. Machines dial out, clients dial in, and frames pass through unchanged. It left open what that relay is.

A relay server that carries frames needs hosts in several regions, uptime, TLS, presence and an update story, and every byte of every session crosses it. Cloudflare Tunnel already does that job. `cloudflared` dials out from the machine, the edge serves TLS on a stable hostname, and WebSockets pass through. Through a tunnel, a 16 MiB frame echoed in under half a second, and a round trip added about 22 ms over direct.

Each developer could create tunnels in their own Cloudflare account, but only developers with a domain on Cloudflare could then use the relay, and each would paste an API token into every machine. A service that creates tunnels in HinaCode's account removes both costs. It needs accounts, because anyone who can mint a tunnel can serve pages under HinaCode's zone and use up the account's tunnel quota.

## Decision

A HinaCode relay service, a Cloudflare Worker with D1 and Clerk accounts, links machines to accounts with a device-code flow and creates one Cloudflare named tunnel per linked machine. The machine runs `cloudflared` with the connector token it receives. The tunnel hostname travels as `relay` in the pairing URL and the `ready` frame, and clients dial it first. The service never carries a frame.

## Consequences

- No developer needs a Cloudflare account or a domain. Linking a machine is one sign-in and one approval.
- HinaCode now runs a service: a Worker, a D1 database, a Clerk application and a tunnel zone. It is small and stateless apart from two tables, and frames never cross it, so its load is one call per machine boot.
- Clerk holds the accounts, so HinaCode stores no emails or passwords. Leaving Clerk later means migrating its users.
- Cloudflare terminates TLS, so it carries frames it cannot read only because they are sealed end to end ([ADR 0024](0024-remote-frames-are-sealed-with-the-pairing-token.md)).
- `cloudflared` becomes a runtime dependency. HinaCode uses the one on `PATH`, or downloads a pinned, checksummed release, so the user installs nothing.
- The remote protocol does not change, so the relay ships without a version bump, and an app that predates it keeps working over direct addresses.
- The service URL is configurable, so a developer who does not want HinaCode's service can run the same Worker on their own account.
- Supersedes slice 3 of `features/2026-10-14-remote-clouds.md`.
- Revisit if the tunnel count approaches Cloudflare's per-account limit, or if relayed traffic needs to stay unreadable to Cloudflare.
