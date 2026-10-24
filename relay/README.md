# HinaCode relay service

A Cloudflare Worker at `relay.hinacode.app`. It links machines to its owner with a device-code flow and creates one Cloudflare named tunnel per linked machine. The machine runs `cloudflared` with the connector token it gets back. The service never carries a frame. The design is in `docs/features/2026-10-24-relay.md` and `docs/adr/0020-cloudflare-tunnel-as-the-relay.md`.

`src/app.ts` holds the handlers. `src/index.ts` wires them to the owner token, `fetch` and the clock. `GET /link` serves the approval page from `src/page.ts`, with no build step. `expiresAt` and `createdAt` are milliseconds since the epoch.

A linked machine publishes the pairing its QR code carries with `PUT /v1/host/pairing`. `GET /v1/machines` hands the owner's devices every machine that published one and is shown, so they can add it without scanning. The page's **Show on my devices** checkbox calls `PATCH /v1/hosts/:id` with `{ enabled }`; a hidden machine's pairing never leaves the relay, and its tunnel keeps running. The design is in `docs/features/2026-10-24-relay-machines.md`.

## One-time setup

1. Create the database with `pnpm exec wrangler d1 create hinacode-relay`. Put its id in `database_id` in `wrangler.jsonc`, then run `pnpm db:migrate`.
2. Pick a zone on Cloudflare for the tunnel hostnames. Keep it apart from `hinacode.app`, so a page a machine serves never shares an origin with the site. Set `TUNNEL_ZONE_NAME` to the zone's name and `TUNNEL_ZONE_ID` to its id.
3. Set `CLOUDFLARE_ACCOUNT_ID` to the account that owns the zone and the tunnels.
4. Create an API token with two permissions: Account, Cloudflare Tunnel, Edit, and Zone, DNS, Edit on the tunnel zone. Store it with `pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN`.
5. Store a long random string as the owner token with `openssl rand -base64 32 | pnpm exec wrangler secret put OWNER_TOKEN`. The link page asks for it once and keeps it in the browser. The relay serves this one account until it has real sign-in. **Rotate owner token** on the page replaces it and keeps only the new token's hash in D1, so the secret stops working. If you lose the rotated token, run `pnpm exec wrangler d1 execute DB --remote --command "DELETE FROM owner"` and put a new `OWNER_TOKEN` secret.

The variables live in `vars` in `wrangler.jsonc`. The two secrets never go in the config. `secrets.required` only names them, so `wrangler types` and `wrangler dev` know about them.

## Local development

1. Copy `.dev.vars.example` to `.dev.vars` and fill it in. A real zone makes the whole flow work. Dummy values are enough to serve the page and create links.
2. Run `pnpm exec wrangler d1 migrations apply DB --local` once.
3. Run `pnpm dev`. The service listens on `http://localhost:8787`. Point HinaCode at it with `HINACODE_RELAY_URL=http://localhost:8787`.

`pnpm test` runs the handlers against real D1 in workerd, with a fake Cloudflare API and a fake sign-in. `pnpm check` regenerates `worker-configuration.d.ts` and type-checks.

## Deploy

Run `pnpm db:migrate` when `migrations/` changed, then `pnpm deploy`. `pnpm deploy:dry-run` builds the Worker without uploading it, as CI does.
